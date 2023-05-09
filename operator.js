const headlessWallet = require('headless-obyte');
const balances = require('ocore/balances.js');

let address;

function getAddress() {
	if (!address)
		throw Error("operator address not set");
	return address;
}

function readBalances(cb) {
	if (!cb)
		return new Promise(resolve => readBalances(resolve));
	balances.readOutputsBalance(getAddress(), cb);
}

async function start() {
	await headlessWallet.waitTillReady();
	return new Promise(resolve => {
		headlessWallet.readFirstAddress(async (addr) => {
			address = addr;
			resolve();
		});
	});
}

exports.getAddress = getAddress;
exports.readBalances = readBalances;
exports.start = start;
