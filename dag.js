"use strict";

const fs = require("fs");
const constants = require('ocore/constants.js');
const objectHash = require('ocore/object_hash.js');
const db = require('ocore/db.js');
const storage = require('ocore/storage.js');
const balances = require('ocore/balances.js');
const network = require('ocore/network.js');
const data_feeds = require('ocore/data_feeds.js');
const formulaEvaluation = require('ocore/formula/evaluation.js');
const parse_ojson = require('ocore/formula/parse_ojson');
const eventBus = require('ocore/event_bus.js');
const conf = require('ocore/conf.js');
const aa_addresses = require("ocore/aa_addresses.js");
const headlessWallet = require('headless-obyte');
const operator = require('./operator.js');



function readAAStateVar(aa_address, var_name, cb) {
	if (!cb)
		return new Promise(resolve => readAAStateVar(aa_address, var_name, resolve));
	console.error('----- readAAStateVar', aa_address, var_name);
	readAAStateVars(aa_address, var_name, assocVars => {
		cb(assocVars[var_name]);
	});
}

function readAAStateVars(aa_address, var_prefix = '', cb) {
	if (!cb)
		return new Promise(resolve => readAAStateVars(aa_address, var_prefix, resolve));
	conf.bLight ? readAAStateVarsLight(aa_address, var_prefix, var_prefix, cb) : readAAStateVarsFull(aa_address, var_prefix, cb);
}

function readAAStateVarsFull(aa_address, var_prefix, cb) {
	storage.readAAStateVars(aa_address, var_prefix, var_prefix, 0, cb);
}

function readAAStateVarsLight(aa_address, var_prefix_from, var_prefix_to, cb) {
	requestFromLightVendorWithRetries('light/get_aa_state_vars', { address: aa_address, var_prefix_from, var_prefix_to }, function (response) {
		let assocVars = response;
		let names = Object.keys(assocVars);
		if (names.length < network.MAX_STATE_VARS)
			return cb(assocVars);
		// request again starting from the last variable
		readAAStateVarsLight(aa_address, names[names.length - 1], var_prefix_to, (assocMoreVars) => {
			Object.assign(assocVars, assocMoreVars);
			cb(assocVars);
		});
	});
}

function executeGetter(aa_address, getter, args, cb) {
	if (!cb)
		return new Promise((resolve, reject) => executeGetter(aa_address, getter, args, (err, res) => {
			err ? reject(err) : resolve(res);
		}));
	let params = { address: aa_address, getter };
	if (args) {
		if (!Array.isArray(args))
			throw Error(`args must be an array, got ${args}`);
		if (args.length > 0) // skip empty argument list
			params.args = args;
	}
	if (conf.bLight)
		requestFromLightVendorWithRetries('light/execute_getter', params, response => cb(response.error, response.result));
	else
		formulaEvaluation.executeGetter(db, aa_address, getter, args || [], cb);
}

function readAABalances(aa_address, cb) {
	if (!cb)
		return new Promise((resolve, reject) => readAABalances(aa_address, (err, res) => {
			err ? reject(err) : resolve(res);
		}));
	if (conf.bLight)
		requestFromLightVendorWithRetries('light/get_aa_balances', { address: aa_address }, response => cb(response.error, response.balances));
	else
		db.query("SELECT asset, balance FROM aa_balances WHERE address=?", [aa_address], function (rows) {
			var assocBalances = {};
			rows.forEach(function (row) {
				assocBalances[row.asset] = row.balance;
			});
			cb(null, assocBalances);
		});
}

function getAAsByBaseAAs(base_aas, cb) {
	if (!cb)
		return new Promise((resolve, reject) => getAAsByBaseAAs(base_aas, (err, res) => {
			err ? reject(err) : resolve(res);
		}));
	if (!Array.isArray(base_aas))
		base_aas = [base_aas];
	if (conf.bLight)
		requestFromLightVendorWithRetries('light/get_aas_by_base_aas', { base_aas: base_aas }, response => cb(response.error, response));
	else
		db.query("SELECT address, definition, unit, creation_date FROM aa_addresses WHERE base_aa IN(?)", [base_aas], function (rows) {
			rows.forEach(function (row) {
				row.definition = JSON.parse(row.definition);
			});
			cb(null, rows);
		});
}

function readAADefinition(aa_address, cb) {
	if (!cb)
		return new Promise((resolve, reject) => readAADefinition(aa_address, (err, res) => {
			err ? reject(err) : resolve(res);
		}));
	if (conf.bLight)
		requestFromLightVendorWithRetries('light/get_definition', aa_address, response => cb(response.error, response));
	else
		storage.readAADefinition(db, aa_address, arrDefinition => {
			cb(null, arrDefinition);
		});
}

// make sure the AA is in our database, light wallets will request it from light vendors if the AA in not in the db yet
async function loadAA(aa_address) {
	const definition_rows = await aa_addresses.readAADefinitions([aa_address]);
	const definition = JSON.parse(definition_rows[0].definition);
	if (definition[1].base_aa)
		await aa_addresses.readAADefinitions([definition[1].base_aa]); // make sure the base AA is in our database
	return definition;
}

async function readAAParams(aa_address) {
	const definition = await loadAA(aa_address);
	if (!definition[1].base_aa)
		throw Error("not a parameterized AA: " + aa_address);
	return definition[1].params;
}

function readBalance(address, cb) {
	if (!cb)
		return new Promise((resolve, reject) => readBalance(address, (err, res) => {
			err ? reject(err) : resolve(res);
		}));
	if (conf.bLight)
		requestFromLightVendorWithRetries('light/get_balances', [address], response => {
			if (response.error)
				return cb(error);
			const assocBalances = response;
			cb(null, assocBalances[address] || {});
		});
	else
		balances.readOutputsBalance(address, assocBalances => cb(null, assocBalances));
}

function getDataFeed(oracle, feed_name, cb) {
	if (!cb)
		return new Promise((resolve, reject) => getDataFeed(oracle, feed_name, (err, res) => {
			err ? reject(err) : resolve(res);
		}));
	let params = { oracles: [oracle], feed_name };
	if (conf.bLight)
		requestFromLightVendorWithRetries('light/get_data_feed', params, response => cb(response.error, response));
	else
		data_feeds.readDataFeedValueByParams(params, 1e15, 'all_unstable', cb);
}

function requestFromLightVendorWithRetries(command, params, cb, count_retries) {
	if (!cb)
		return new Promise(resolve => requestFromLightVendorWithRetries(command, params, resolve));
	count_retries = count_retries || 0;
	network.requestFromLightVendor(command, params, (ws, request, response) => {
		if (response.error && Object.keys(response).length === 1) {
			if (response.error.startsWith('[internal]') || response.error.startsWith('[connect to light vendor failed]')) {
				console.log(`got ${response.error} from ${command} ${JSON.stringify(params)}`);
				if (count_retries > 3)
					throw Error("got error after 3 retries: " + response.error);
				return setTimeout(() => requestFromLightVendorWithRetries(command, params, cb, count_retries + 1), 10000);
			}
			else
				console.log(`got ${response.error} from ${command} ${JSON.stringify(params)}`);
			//	throw Error(`got ${response.error} from ${command} ${JSON.stringify(params)}`);
		}
		cb(response);
	});
}

function readJoint(unit, cb, bRetrying) {
	if (!unit)
		throw Error(`no unit in readJoint`);
	if (!cb)
		return new Promise(resolve => readJoint(unit, resolve));
	storage.readJoint(db, unit, {
		ifFound: cb,
		ifNotFound() {
			if (!conf.bLight || bRetrying)
				throw Error("unit not found: " + unit);
			network.requestHistoryFor([unit], [], () => {
				readJoint(unit, cb, true);
			});
		}
	});
}

function getLastStableUnitProps(cb) {
	if (!cb)
		return new Promise((resolve, reject) => getLastStableUnitProps((err, res) => {
			err ? reject(err) : resolve(res);
		}));
	if (conf.bLight) {
		requestFromLightVendorWithRetries('get_last_stable_unit_props', null, response => cb(response.error, response));
	}
	else {
		storage.readLastStableMcUnitProps(db, function (props) {
			cb(null, {
				unit: props.unit,
				main_chain_index: props.main_chain_index,
				timestamp: props.timestamp,
			});
		});
	}
}

async function sendAARequest(to_address, data) {
	return await sendMessage({
		to_address,
		amount: constants.MIN_BYTES_BOUNCE_FEE,
		app: 'data',
		payload: data
	});
}

async function defineAA(definition) {
	return await sendMessage({
		app: 'definition',
		payload: {
			definition: definition,
			address: objectHash.getChash160(definition)
		}
	});
}

function parseOjson(str) {
	return new Promise((resolve, reject) => parse_ojson.parse(str, (err, definition) => err ? reject(err) : resolve(definition)));
}

async function deployAAFromFile(filename, deployEvenIfAlreadyExists = false) {
	const str = fs.readFileSync(filename, 'utf8');
	const definition = await parseOjson(str);
	if (!deployEvenIfAlreadyExists) {
		const aa_address = objectHash.getChash160(definition);
		const definition_rows = await aa_addresses.readAADefinitions([aa_address]);
		if (definition_rows.length > 0) {
			console.log(`AA ${aa_address} from ${filename} already deployed`);
			return null;
		}
	}
	const unit = await defineAA(definition);
	if (!unit)
		throw Error(`failed to deploy ${filename}`);
	return unit;
}


async function defineAsset(assetProps = {}) {
	if (assetProps.is_private === undefined)
		assetProps.is_private = false;
	if (assetProps.is_transferrable === undefined)
		assetProps.is_transferrable = true;
	if (assetProps.auto_destroy === undefined)
		assetProps.auto_destroy = false;
	if (assetProps.fixed_denominations === undefined)
		assetProps.fixed_denominations = false;
	if (assetProps.issued_by_definer_only === undefined)
		assetProps.issued_by_definer_only = true;
	if (assetProps.cosigned_by_definer === undefined)
		assetProps.cosigned_by_definer = false;
	if (assetProps.spender_attested === undefined)
		assetProps.spender_attested = false;
	return await sendMessage({ app: 'asset', payload: assetProps });
}

async function sendMessage({ to_address, amount, app, payload }) {
	let json = JSON.stringify(payload);
	let message = {
		app: app,
		payload_location: 'inline',
		payload: payload
	};
	message.payload_hash = objectHash.getBase64Hash(message.payload, true);
	let opts = {
		messages: [message],
		paying_addresses: [operator.getAddress()],
		change_address: operator.getAddress(),
		spend_unconfirmed: 'all',
	};
	if (to_address)
		opts.to_address = to_address;
	if (amount)
		opts.amount = amount;
	try {
		let { unit } = await headlessWallet.sendMultiPayment(opts);
		console.log("sent " + json + " request, unit " + unit);
		return unit;
	}
	catch (e) {
		console.error("failed to send " + json + " request: " + e);
		return null;
	}
}

async function sendPayment({ to_address, amount, asset, amountsByAsset, data, is_aa }) {
	if (amountsByAsset && (amount || asset))
		throw Error(`amountsByAsset combined with amount or asset`);
	let opts = {
		paying_addresses: [operator.getAddress()],
		change_address: operator.getAddress(),
		spend_unconfirmed: 'all',
	};
	if (amountsByAsset) {
		opts.outputs_by_asset = {};
		if (is_aa) {
			if (!amountsByAsset.base)
				amountsByAsset.base = constants.MIN_BYTES_BOUNCE_FEE;
			else if (amountsByAsset.base < constants.MIN_BYTES_BOUNCE_FEE)
				throw Error(`bytes payment ${amountsByAsset.base} is less than bounce fees`);
		}
		for (let asset in amountsByAsset)
			opts.outputs_by_asset[asset] = [{ address: to_address, amount: amountsByAsset[asset] }];
	}
	else {
		if (asset && asset !== 'base')
			opts.asset = asset;
		if (opts.asset && is_aa) {
			opts.base_outputs = [{ address: to_address, amount: constants.MIN_BYTES_BOUNCE_FEE }];
			opts.asset_outputs = [{ address: to_address, amount }];
		}
		else {
			opts.to_address = to_address;
			opts.amount = amount;
		}
	}
	const desc = amountsByAsset ? JSON.stringify(amountsByAsset) : amount;;
	if (data) {
		let message = {
			app: 'data',
			payload_location: 'inline',
			payload: data,
		};
		message.payload_hash = objectHash.getBase64Hash(message.payload, true);
		opts.messages = [message];
	}
	try {
		let { unit } = await headlessWallet.sendMultiPayment(opts);
		console.log("sent " + desc + " to " + to_address + ", unit " + unit);
		return unit;
	}
	catch (e) {
		console.error("failed to send " + desc + " to " + to_address + ": " + e);
		return null;
	}
}

async function getAAResponseToTrigger(aa_address, trigger_unit) {
	const [aa_response] = await db.query("SELECT * FROM aa_responses WHERE aa_address=? AND trigger_unit=?", [aa_address, trigger_unit]);
	if (aa_response) {
		aa_response.response = JSON.parse(aa_response.response);
		return aa_response;
	}
	// assuming there is only one response, i.e. we didn't send to 2 AAs in one trigger
	return new Promise(resolve => eventBus.once('aa_response_to_unit-' + trigger_unit, resolve));
}



exports.readJoint = readJoint;
exports.getLastStableUnitProps = getLastStableUnitProps;
exports.readAADefinition = readAADefinition;
exports.loadAA = loadAA;
exports.readAAParams = readAAParams;
exports.readAAStateVar = readAAStateVar;
exports.readAAStateVars = readAAStateVars;
exports.readAABalances = readAABalances;
exports.readBalance = readBalance;
exports.getDataFeed = getDataFeed;
exports.executeGetter = executeGetter;
exports.getAAsByBaseAAs = getAAsByBaseAAs;
exports.sendAARequest = sendAARequest;
exports.defineAA = defineAA;
exports.deployAAFromFile = deployAAFromFile;
exports.defineAsset = defineAsset;
exports.sendMessage = sendMessage;
exports.sendPayment = sendPayment;
exports.getAAResponseToTrigger = getAAResponseToTrigger;
