"use strict";

const _ = require('lodash');
const eventBus = require('ocore/event_bus.js');
const network = require('ocore/network.js');
const mutex = require('ocore/mutex.js');
const aa_composer = require('ocore/aa_composer.js');
const formulaEvaluation = require("ocore/formula/evaluation.js");
const dag = require('./dag.js');

let assocFollowedAAs = {};

let stateVars = {};
let upcomingStateVars = {};
let balances = {};
let upcomingBalances = {};

let arrPendingTriggers = [];

let last_trigger_unit;

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
	return formulaEvaluation.stateVars2assoc(upcomingStateVars[aa_address]);
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
	upcomingStateVars[address] = _.cloneDeep(sv);
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

async function onAAResponse(objAAResponse) {
	const unlock = await lock();
	console.log(`onAAResponse`, objAAResponse);
	const aa_address = objAAResponse.aa_address;
	if (objAAResponse.trigger_initial_unit !== last_trigger_unit) { 
		removeExecutedPendingTriggers(objAAResponse.trigger_initial_unit);
		last_trigger_unit = objAAResponse.trigger_initial_unit;
	}
	else // we are called several times when a chain is executed
		console.log(`repeated response to ${last_trigger_unit}`);
	if (objAAResponse.updatedStateVars) {
		for (let address in objAAResponse.updatedStateVars) {
			if (!stateVars[address])
				stateVars[address] = {};
			let vars = objAAResponse.updatedStateVars[address];
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
	const aa_address = objAARequest.aa_address;
	const objUnit = objAARequest.unit;
	if (!objUnit.messages) // final-bad
		return console.log("no messages");
	const unlock = await lock();
	if (arrPendingTriggers.find(pt => pt.unit.unit === objUnit.unit)) {
		console.log(`trigger ${objUnit.unit} already queued`);
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
	arrPendingTriggers.push(objAARequest);
	unlock();
	eventBus.emit('aa_request_applied-' + aa_address, objAARequest);
	eventBus.emit('aa_request_applied', objAARequest);
}

function onAADefinition(objUnit) {
	const definitionPayload = objUnit.messages.find(m => m.app === 'definition').payload;
	const address = definitionPayload.address;
	const definition = definitionPayload.definition;
	const base_aa = definition[1].base_aa;
	eventBus.emit('aa_definition_applied-' + base_aa, address, definition, objUnit);
	eventBus.emit('aa_definition_applied', address, definition, objUnit);
}

async function replayPendingTriggers() {
	console.log(`will replay ${arrPendingTriggers.length} pending triggers`);
	upcomingBalances = _.cloneDeep(balances);
	upcomingStateVars = _.cloneDeep(stateVars);
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
