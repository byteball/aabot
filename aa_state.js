"use strict";

const _ = require('lodash');
const eventBus = require('ocore/event_bus.js');
const network = require('ocore/network.js');
const mutex = require('ocore/mutex.js');
const aa_composer = require('ocore/aa_composer.js');
const formulaEvaluation = require("ocore/formula/evaluation.js");
const dag = require('./dag.js');
const wrappedObject = formulaEvaluation.wrappedObject;

let assocFollowedAAs = {};

let stateVars = {};
let upcomingStateVars = {};
let balances = {};
let upcomingBalances = {};

let arrPendingTriggers = [];

let last_trigger_unit;

let expectedResponses = {};

function customizer(value) {
	if (value instanceof wrappedObject)
		return new wrappedObject(_.cloneDeep(value.obj));
}

function getStateVars() {
	return stateVars;
}

function getAAStateVars(aa_address) {
	return formulaEvaluation.stateVars2assoc(stateVars[aa_address]);
}

// should be accessed under lock, otherwise might return state vars in the middle of replayPendingTriggers()
function getUpcomingStateVars() {
	return upcomingStateVars;
}

// should be accessed under lock, otherwise might return state vars in the middle of replayPendingTriggers()
function getUpcomingAAStateVars(aa_address) {
	let vars = formulaEvaluation.stateVars2assoc(upcomingStateVars[aa_address]);
	for (let var_name in vars)
		if (vars[var_name] === false) // deleted var
			delete vars[var_name];
	return vars;
}

function getBalances() {
	return balances;
}

// should be accessed under lock, otherwise might return balances in the middle of replayPendingTriggers()
function getUpcomingBalances() {
	return upcomingBalances;
}


async function getFinalUpcomingBalances() {
	const unlock = await lock();
	const ub = upcomingBalances;
	unlock();
	return ub;
}

async function getFinalUpcomingStateVars() {
	const unlock = await lock();
	const sv = getUpcomingStateVars();
	unlock();
	return sv;
}

async function getFinalUpcomingAAStateVars(aa_address) {
	const unlock = await lock();
	const sv = getUpcomingAAStateVars(aa_address);
	unlock();
	return sv;
}


function addStateVars(address, assoc) {
	let sv = formulaEvaluation.assoc2stateVars(assoc);
	stateVars[address] = sv;
	upcomingStateVars[address] = _.cloneDeepWith(sv, customizer);
}

function addBalances(address, balancesByAsset) {
	balances[address] = balancesByAsset;
	upcomingBalances[address] = _.cloneDeep(balancesByAsset);
}

/*
async function updateBalances(objAAResponse) {
	const aa_address = objAAResponse.aa_address;
	const objJoint = await dag.readJoint(objAAResponse.trigger_unit);
	const objUnit = objJoint.unit;
	if (!balances[aa_address])
		balances[aa_address] = {};
	const paymentMessagesIn = objUnit.messages.filter(message => message.app === 'payment');
	paymentMessagesIn.forEach(message => {
		const payload = message.payload;
		const asset = payload.asset || 'base';
		if (!balances[aa_address][asset])
			balances[aa_address][asset] = 0;
		const amount = payload.outputs.reduce((acc, o) => acc + (o.address === aa_address ? o.amount : 0), 0);
		if (!Number.isFinite(amount))
			throw Error("bad amount");
		balances[aa_address][asset] += amount;
	});
	if (objAAResponse.objResponseUnit) {
		const paymentMessagesOut = objAAResponse.objResponseUnit.messages.filter(message => message.app === 'payment');
		paymentMessagesOut.forEach(message => {
			const payload = message.payload;
			const asset = payload.asset || 'base';
			if (!balances[aa_address][asset])
				balances[aa_address][asset] = 0;
			const amount = payload.outputs.reduce((acc, o) => acc + (o.address !== aa_address ? o.amount : 0), 0);
			if (!Number.isFinite(amount))
				throw Error("bad amount");
			balances[aa_address][asset] -= amount;
		});
	}
}*/

// returns the function that should be called to release the lock
async function lock() {
	const unlock = await mutex.lock('aa_state');
	return unlock;
}

function getResponseEssentials(objAAResponse) {
	const { mci, timestamp, bounced, aa_address, objResponseUnit, response: { responseVars }, balances: b } = objAAResponse;
	let balances = _.cloneDeep(b);
	delete balances.base; // ignore, fees are approximate
	if (objResponseUnit) {
		var messages = _.cloneDeep(objResponseUnit.messages);
		for (let m of messages) {
			delete m.payload_location;
			delete m.payload_hash;
			if (m.app === 'payment') {
				if (!m.payload.asset)
					m.payload.asset = 'base';
				delete m.payload.inputs;
				m.payload.outputs = m.payload.outputs.filter(o => o.address !== aa_address);
			}
		}
		messages = messages.filter(m => m.app !== 'payment' || m.payload.outputs.length > 0);
		messages.sort((m1, m2) => {
			if (m1.app < m2.app)
				return -1;
			if (m1.app > m2.app)
				return 1;
			if (m1.app === 'payment')
				return (m1.payload.asset < m2.payload.asset) ? -1 : 1;
			console.log(`unsorted app`, m1, m2);
			return 1;
		});
	}
	return { timestamp, bounced, responseVars, messages, balances }; // mci is always wrong
}

function getMaxDifference(v1, v2) {
	if (v1 === v2)
		return 0;
	if (typeof v1 !== typeof v2)
		return Infinity;
	switch (typeof v1) {
		case 'number':
			return Math.abs(v1 - v2) / (v1 + v2) * 2;
		case 'string':
			if (v1.endsWith('%') && v2.endsWith('%')) {
				v1 = v1.slice(0, -1);
				v2 = v2.slice(0, -1);
			}
			try {
				// JSON.parse() also converts strings to numbers "123" => 123)
				var j1 = JSON.parse(v1);
				var j2 = JSON.parse(v2);
			}
			catch (e) {
				return Infinity;
			}
			return getMaxDifference(j1, j2);
		case 'object':
			if (Array.isArray(v1) !== Array.isArray(v2))
				return Infinity;
			let max_diff = 0;
			if (Array.isArray(v1)) {
				if (v1.length !== v2.length)
					return Infinity;
				for (let i = 0; i < v1.length; i++) {
					const diff = getMaxDifference(v1[i], v2[i]);
					if (diff > max_diff)
						max_diff = diff;
				}
			}
			else {
				if (!_.isEqual(Object.keys(v1).sort(), Object.keys(v2).sort()))
					return Infinity;
				for (let key in v1) {
					const diff = getMaxDifference(v1[key], v2[key]);
					if (diff > max_diff)
						max_diff = diff;
				}
			}
			return max_diff;
		default:
			return Infinity;
	}
}

async function onAAResponse(objAAResponse) {
	const unlock = await lock();
	console.log(`onAAResponse`, objAAResponse);
	const { aa_address, trigger_address, trigger_unit, trigger_initial_unit, updatedStateVars } = objAAResponse;
	const expectedResponse = expectedResponses[trigger_unit];
	if (expectedResponse) {
		const essentials = getResponseEssentials(objAAResponse);
		const same = _.isEqual(expectedResponse, essentials);
		const matches = same ? 'matches' : 'mismatches';
		const relDiff = (field) => (getMaxDifference(expectedResponse[field], essentials[field]) * 100).toPrecision(1) + '%';
		const difference = same ? '' : `, ts ${relDiff('timestamp')}, r ${relDiff('responseVars')}, m ${relDiff('messages')}, b ${relDiff('balances')}`;
		console.log(`trigger ${trigger_unit} from ${trigger_address} to ${aa_address}: response ${matches} expectations${difference}`);
		if (!same)
			console.log('expected', JSON.stringify(expectedResponse, null, 2), 'actual', JSON.stringify(essentials, null, 2));
		delete expectedResponses[trigger_unit];
	}
	if (trigger_initial_unit !== last_trigger_unit) { 
		removeExecutedPendingTriggers(trigger_initial_unit);
		last_trigger_unit = trigger_initial_unit;
	}
	else // we are called several times when a chain is executed
		console.log(`repeated response to ${last_trigger_unit}`);
	if (updatedStateVars) {
		for (let address in updatedStateVars) {
			if (!stateVars[address])
				stateVars[address] = {};
			let vars = updatedStateVars[address];
			for (let var_name in vars) {
				let varInfo = vars[var_name];
				console.log(`updating: ${address} : ${var_name} = ${JSON.stringify(varInfo, null, 2)}`);
				if (varInfo.value === false)
					delete stateVars[address][var_name];
				else {
					let value = formulaEvaluation.toOscriptType(varInfo.value);
					stateVars[address][var_name] = {
						value: value,
						old_value: value,
						original_old_value: value,
					};
				}
			}
		}
	}
	if (!objAAResponse.balances) // balances are available only in light wallets, they are added to the notifications we receive from the light vendor
		throw Error("no balances in AA response");
	balances[aa_address] = objAAResponse.balances;
//	await updateBalances(objAAResponse);
	await replayPendingTriggers();
	unlock();
	eventBus.emit('aa_response_applied-' + aa_address, objAAResponse);
	eventBus.emit('aa_response_applied', objAAResponse);
}

async function onAARequest(objAARequest) {
	const { aa_address, unit: objUnit } = objAARequest;
	const { unit, messages } = objUnit;
	if (!messages) // final-bad
		return console.log("no messages");
	const unlock = await lock();
	if (arrPendingTriggers.find(pt => pt.unit.unit === unit)) {
		console.log(`trigger ${unit} already queued`);
		return unlock();
	}
	console.log(`onAARequest`, objAARequest);
	if (!balances[aa_address]) {
		console.log(`don't know the balances of AA ${aa_address} yet`);
		let balancesByAsset = await dag.readAABalances(aa_address);
		addBalances(aa_address, balancesByAsset);
	}
	let arrResponses = await aa_composer.estimatePrimaryAATrigger(objUnit, aa_address, upcomingStateVars, upcomingBalances);
	console.log(`--- estimated responses`, JSON.stringify(arrResponses, null, 2));
	expectedResponses[unit] = getResponseEssentials(arrResponses[0])
	arrPendingTriggers.push(objAARequest);
	unlock();
	eventBus.emit('aa_request_applied-' + aa_address, objAARequest, arrResponses);
	eventBus.emit('aa_request_applied', objAARequest, arrResponses);
}

function onAADefinition(objUnit) {
	const definitionMessages = objUnit.messages.filter(m => m.app === 'definition');
	for (let message of definitionMessages) {
		const definitionPayload = message.payload;
		const address = definitionPayload.address;
		const definition = definitionPayload.definition;
		const base_aa = definition[1].base_aa;
		eventBus.emit('aa_definition_applied-' + base_aa, address, definition, objUnit);
		eventBus.emit('aa_definition_applied', address, definition, objUnit);
	}
}

async function replayPendingTriggers() {
	console.log(`will replay ${arrPendingTriggers.length} pending triggers`);
	upcomingBalances = _.cloneDeep(balances);
	upcomingStateVars = _.cloneDeepWith(stateVars, customizer);
	for (let pt of arrPendingTriggers) {
		console.log('replaying trigger ' + pt.unit.unit + ' to ' + pt.aa_address);
		await aa_composer.estimatePrimaryAATrigger(pt.unit, pt.aa_address, upcomingStateVars, upcomingBalances);
		console.log('replayed trigger ' + pt.unit.unit + ' to ' + pt.aa_address);
	}
	console.log(`finished replaying pending triggers`);
}

function removeExecutedPendingTriggers(trigger_initial_unit) {
	let i = arrPendingTriggers.findIndex(pt => pt.unit.unit === trigger_initial_unit);
	console.log(`removeExecutedPendingTriggers after ${trigger_initial_unit} will remove ${i + 1} triggers`);
	if (i < 0)
		return;
	arrPendingTriggers.splice(0, i + 1);
}

async function followAA(aa_address) {
	if (assocFollowedAAs[aa_address])
		return;
	
	await dag.loadAA(aa_address);

	const stateVars = await dag.readAAStateVars(aa_address, '');
	console.log('stateVars of ' + aa_address, JSON.stringify(stateVars, null, 2))
	addStateVars(aa_address, stateVars);

	const balancesByAsset = await dag.readAABalances(aa_address);
	addBalances(aa_address, balancesByAsset);

//	walletGeneral.addWatchedAddress(aa_address);
	// subscribe to light/aa_response, light/aa_request, and light/aa_definition
	network.addLightWatchedAa(aa_address, null, err => {
		if (err)
			throw Error(err);
	});
	
	assocFollowedAAs[aa_address] = true;
}

eventBus.on("message_for_light", (ws, subject, body) => {
	switch (subject) {
		case 'light/aa_response':
			onAAResponse(body);
			break;
		case 'light/aa_request':
			onAARequest(body);
			break;
		case 'light/aa_definition':
			onAADefinition(body);
			break;
	}
});

// full only
eventBus.on("aa_definition_saved", async (payload, unit) => {
	const objJoint = await dag.readJoint(unit);
	onAADefinition(objJoint.unit);
});

exports.addStateVars = addStateVars;
exports.getStateVars = getStateVars;
exports.getAAStateVars = getAAStateVars;
exports.getUpcomingStateVars = getUpcomingStateVars;
exports.getUpcomingAAStateVars = getUpcomingAAStateVars;

exports.addBalances = addBalances;
exports.getBalances = getBalances;
exports.getUpcomingBalances = getUpcomingBalances;

exports.getFinalUpcomingBalances = getFinalUpcomingBalances;
exports.getFinalUpcomingStateVars = getFinalUpcomingStateVars;
exports.getFinalUpcomingAAStateVars = getFinalUpcomingAAStateVars;

exports.onAARequest = onAARequest;

exports.followAA = followAA;

exports.lock = lock;
