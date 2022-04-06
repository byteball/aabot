"use strict";
const data_feeds = require('ocore/data_feeds.js');
const network = require('ocore/network.js');
const eventBus = require('ocore/event_bus.js');
const string_utils = require('ocore/string_utils.js');
const dag = require('./dag.js');

const ORACLE_DATA_LIFETIME = 60 * 1000;
let oracles = [];

// replace the function
data_feeds.readDataFeedValue = function (arrAddresses, feed_name, value, min_mci, max_mci, bAA, ifseveral, handleResult) {
	for (let oracle of oracles) {
		if (arrAddresses.includes(oracle.address) && feed_name === oracle.feed_name)
			return handleResult({ value: oracle.value });
	}
	throw Error("light data feed not found: " + arrAddresses + ":" + feed_name);
}

function getOracle(address, feed_name) {
	for (let oracle of oracles)
		if (oracle.address === address && oracle.feed_name === feed_name)
			return oracle;
	let oracle = { address, feed_name, ts: 0 };
	oracles.push(oracle);
	return oracle;
}

async function updateDataFeed(oracle_address, feed_name, bForce) {
	let oracle = getOracle(oracle_address, feed_name);
	if (oracle.ts > Date.now() - ORACLE_DATA_LIFETIME && !bForce)
		return console.log(`oracle ${oracle_address}:${feed_name} data is up to date`);
	if (oracle.ts === 0) // new oracle
		network.addTempLightWatchedAddress(oracle_address);
	console.log(`will update oracle ${oracle_address}:${feed_name}`);
	const prev_value = oracle.value;
	try {
		oracle.value = await dag.getDataFeed(oracle_address, feed_name);
	}
	catch (e) {
		console.log(`getting data feed ${oracle_address}:${feed_name} failed:`, e);
		// oracle.value stays undefined if the data feed doesn't exist
	}
	oracle.ts = Date.now();
	const bUpdated = (oracle.value !== prev_value);
	console.log(`oracles now`, JSON.stringify(oracles));
	console.log(`oracle ${oracle_address}:${feed_name}`, bUpdated ? `updated from ${prev_value} to ${oracle.value}` : `same value ${prev_value}`);
	return bUpdated;
}

eventBus.on('new_joint', objJoint => {
	const objUnit = objJoint.unit;
	const author_addresses = objUnit.authors.map(a => a.address);
	const df_message = objUnit.messages.find(m => m.app === 'data_feed');
	if (!df_message)
		return console.log('no data feed in unit', objUnit.unit);
	const df = df_message.payload;
	for (let address of author_addresses)
		for (let oracle of oracles)
			if (oracle.address === address && df[oracle.feed_name]) {
				console.log(`${objUnit.unit}: received new value of data feed ${oracle.address}:${oracle.feed_name}`, df[oracle.feed_name]);
				oracle.value = string_utils.getFeedValue(df[oracle.feed_name]);
				oracle.ts = Date.now();
			}
});

exports.updateDataFeed = updateDataFeed;
