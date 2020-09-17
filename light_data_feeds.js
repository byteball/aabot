"use strict";
const data_feeds = require('ocore/data_feeds.js');
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
	console.log(`will update oracle ${oracle_address}:${feed_name}`);
	const prev_value = oracle.value;
	oracle.value = await dag.getDataFeed(oracle_address, feed_name);
	oracle.ts = Date.now();
	const bUpdated = (oracle.value !== prev_value);
	console.log(`oracles now`, JSON.stringify(oracles));
	console.log(`oracle ${oracle_address}:${feed_name}`, bUpdated ? `updated from ${prev_value} to ${oracle.value}` : `same value ${prev_value}`);
	return bUpdated;
}

exports.updateDataFeed = updateDataFeed;
