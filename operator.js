const headlessWallet = require('headless-obyte');

let address;

function getAddress() {
	if (!address)
		throw Error("operator address not set");
	return address;
}

async function start() {
	return new Promise(resolve => {
		headlessWallet.readFirstAddress(async (addr) => {
			address = addr;
			resolve();
		});
	});
}

exports.getAddress = getAddress;
exports.start = start;
