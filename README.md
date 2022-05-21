# AA Bot

An Obyte node for interacting with Autonomous Agents and tracking their state.

Use it in your trading bots that need to predict the future state of Autonomous Agents (AAs) immediately after a triggering request is received, without waiting for its execution. Based on this information, your bot can send transactions and try to be the first to seize an arbitrage opportunity. 

## Requirements
nodejs 8+

## Usage
Add as a dependency in your package.json:
```
  "dependencies": {
	...
	"aabot": "git+https://github.com/byteball/aabot.git",
	...
  },
```

Require:
```js
const conf = require('ocore/conf.js');
const aa_state = require('aabot/aa_state.js');
const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');
const tokenRegistry = require('aabot/tokenRegistry.js');
const light_data_feeds = conf.bLight ? require('aabot/light_data_feeds.js') : null;

```
Start the built-in wallet:
```js
await operator.start();
```

Start following an AA:
```js
await aa_state.followAA(aa_address);
```
From now on, all triggers to this AA will be executed immediately upon receipt and an estimation of the future AA state will be available as:
```js
// returns the estimated future state of all followed AAs, this object can be used in calls 
// to aa_composer.estimatePrimaryAATrigger() if you want to estimate the effects of a trigger 
// without actually sending it
let upcomingStateVars = aa_state.getUpcomingStateVars();

// returns the estimated future state vars of a single followed AA, 
// the returned object has the format {var_name1: var_value1, ...}
let upcomingAAStateVars = aa_state.getUpcomingAAStateVars(aa_address);

// returns the estimated future balances of all followed AAs, 
// the returned object has the format { aa_address1: {asset1: balance1, ...}, ... }
let upcomingBalances = aa_state.getUpcomingBalances();

```
If you want to be notified after a trigger is applied, set event handlers:
```js
const eventBus = require('ocore/event_bus.js');

eventBus.on("aa_request_applied", (objAARequest) => {
	const aa_address = objAARequest.aa_address;
	const objUnit = objAARequest.unit;
	// ...
});
eventBus.on("aa_response_applied", (objAAResponse) => {
	const aa_address = objAAResponse.aa_address;
	if (objAAResponse.bounced)
		return console.log(`${aa_address} bounced with error ${objAAResponse.response.error}`);
	const responseVars = objAAResponse.response.responseVars;
	// ...
});
eventBus.on("aa_definition_applied", (aa_address, definition, objUnit) => {
	// ...
});
```
You can also subscribe to events on specific AAs only:
```js
eventBus.on("aa_request_applied-" + aa_address, (objAARequest) => {
	// ...
});
eventBus.on("aa_response_applied-" + aa_address, (objAAResponse) => {
	// ...
});
eventBus.on("aa_definition_applied" + base_aa, (aa_address, definition, objUnit) => {
	// ...
});
```

If you created a transaction and want its effects to be immediately reflected in state vars and balances, call `aa_state.onAARequest()` manually:
```js
aa_state.onAARequest({ unit: objUnit, aa_address: aa_address });
```

The estimations of the future AA state are not perfect and might be wrong in some edge cases. Once a trigger is processed by the DAG and a final response is received, the state vars and balances are updated and all pending triggers are replayed starting from the last known final state.

If you need to work with the upcoming state vars/balances and want to be sure you don't get them in the middle of a replay cycle and they are not affected by new triggers, get a lock:
```js
const unlock = await aa_state.lock();
```
Call the returned `unlock()` function to release the lock:
```js
unlock();
```

### Data feeds
Some AAs need the latest data from data feeds. If you are on a light node, you need to request the latest values of specific data feeds from your light vendor (hub) to make sure the estimations are based on the latest data. Use `light_data_feeds.updateDataFeed()`:
```js
if (conf.bLight)
	for (let oracle of oracles)
		await light_data_feeds.updateDataFeed(oracle.oracle, oracle.feed_name);

async function updateDataFeeds(bForce, bQuiet) {
	if (!conf.bLight)
		return;
	let bUpdated = false;
	for (let oracle of oracles)
		if (await light_data_feeds.updateDataFeed(oracle.oracle, oracle.feed_name, bForce))
			bUpdated = true;
	if (bUpdated && !bQuiet)
		eventBus.emit('data_feeds_updated');
}
setInterval(() => updateDataFeeds(), 10 * 60 * 1000);
```

### DAG inspection
Some useful functions to inspect the final (not upcoming) state of the DAG.

Read several state vars by prefix of variable name:
```js
const vars = await dag.readAAStateVars(aa_address, var_prefix);
```
Read a single state var:
```js
const value = await dag.readAAStateVar(aa_address, var_name);
```
Execute getter on an AA:
```js
const returnValue = await dag.executeGetter(aa_address, getter, args);
```
Get AA balances (keyed by asset):
```js
const balances = await dag.readAABalances(aa_address);
```
Get the list of parameterized AAs based on an array of base AAs:
```js
const rows = await dag.getAAsByBaseAAs([base_aa1, base_aa2]);
for (let row of rows) {
	const definition = row.definition;
	const address = row.address;
	// ...
}
```
Get AA definition:
```js
const definition = await dag.readAADefinition(aa_address);
```
Load an AA (for light nodes) to make sure it is stored in our database:
```js
await dag.loadAA(aa_address);
```
Read params of a parameterized AA:
```js
const params = await dag.readAAParams(aa_address);
```
Read the balance of any address (not just an AA):
```js
const balances = await dag.readBalance(address);
```
The returned object has the format `{asset1: {stable: 600, pending: 100, total: 700}, ...}`.

Get data feed value:
```js
const value = await dag.getDataFeed(oracle, feed_name);
```
Read a unit:
```js
const objJoint = await dag.readJoint(unit);
const objUnit = objJoint.unit;
```

### Sending transactions to the DAG
Send a request (without any coins apart from the bounce fees) to an AA:
```js
const unit = await dag.sendAARequest(aa_address, data);
```
Define a new AA:
```js
const unit = await dag.defineAA(definition);
```
Send any payment (to AA or non-AA), optionally with data:
```js
const unit = await dag.sendPayment({ to_address, amount, asset, data });
```
In the above functions, if sending of the transaction failed, the returned `unit` is `null`.

### Operator
This node is a single-address wallet. Use
```js
const operator_address = operator.getAddress();
```
to learn its address.


### Token registry
Get token symbol by asset:
```js
const tokenRegistry = require('aabot/tokenRegistry.js');

const symbol = await tokenRegistry.getSymbolByAsset("AHVV8Um6AwHY9/nsX/YMZkWSBptWdn4g9aYVhNLcUWs="); // BNB
```
Get token asset by symbol:
```js
const asset = await tokenRegistry.getAssetBySymbol("BNB"); // AHVV8Um6AwHY9/nsX/YMZkWSBptWdn4g9aYVhNLcUWs=
```
Get token decimals by symbol or asset:
```js
const decimals = await tokenRegistry.getDecimalsBySymbolOrAsset("BNB"); // 4
```