const { isValidAddress } = require('ocore/validation_utils');
const dag = require('./dag.js');
const conf = require('ocore/conf.js');

const tokenRegistryAddress = 'O6H6ZIFI57X3PLTYHOCVYPP5A553CYFQ';
const CACHE_LIFETIME = conf.TOKEN_REGISTRY_CACHE_LIFETIME || 24 * 3600 * 1000; // 1 day in ms

const cache = {
  symbolByAsset: {},
  assetBySymbol: {},
  decimalsBySymbolOrAsset: {}
}

async function getSymbolByAsset(asset, customTokenRegistryAddress) {
  const registryAddress = customTokenRegistryAddress || tokenRegistryAddress;
  const symbolByAssetCache = cache.symbolByAsset;

  if (asset === 'base') return 'GBYTE';

  if (asset === '' || typeof asset !== 'string') throw Error(`not valid asset`);

  if (!isValidAddress(registryAddress)) throw Error(`not valid token registry address`);

  if (!(registryAddress in symbolByAssetCache)) symbolByAssetCache[registryAddress] = {};

  if ((asset in symbolByAssetCache[registryAddress]) && symbolByAssetCache[registryAddress][asset].ts + CACHE_LIFETIME >= Date.now()) return symbolByAssetCache[registryAddress][asset].symbol;

  const symbol = await dag.readAAStateVar(registryAddress, `a2s_${asset}`);

  if (symbol) {
    cache.symbolByAsset[registryAddress][asset] = { symbol, ts: Date.now() };
  }

  return symbol || null;
}

async function getAssetBySymbol(symbol, customTokenRegistryAddress) {
  const registryAddress = customTokenRegistryAddress || tokenRegistryAddress;
  const assetBySymbolCache = cache.assetBySymbol;

  if (symbol === '' || typeof symbol !== 'string') throw Error(`not valid symbol`);

  if (symbol === 'GBYTE' || symbol === 'MBYTE' || symbol === 'KBYTE' || symbol === 'BYTE') return 'base';

  if (!isValidAddress(registryAddress)) throw Error(`not valid token registry address`);

  if (!(registryAddress in assetBySymbolCache)) cache.assetBySymbol[registryAddress] = {};

  if ((symbol in assetBySymbolCache[registryAddress]) && (assetBySymbolCache[registryAddress][symbol].ts + CACHE_LIFETIME >= Date.now())) return assetBySymbolCache[registryAddress][symbol].asset;

  const asset = await dag.readAAStateVar(registryAddress, `s2a_${symbol}`);

  if (asset) {
    cache.assetBySymbol[registryAddress][symbol] = { asset, ts: Date.now() };
  }

  return asset || null;
}

async function getDecimalsBySymbolOrAsset(symbolOrAsset, customTokenRegistryAddress) {
  const registryAddress = customTokenRegistryAddress || tokenRegistryAddress;
  const decimalsBySymbolOrAssetCache = cache.decimalsBySymbolOrAsset;

  if (!isValidAddress(registryAddress)) throw Error(`not valid token registry address`);

  if (symbolOrAsset === '' || typeof symbolOrAsset !== 'string') throw Error(`not valid symbol or asset`);

  if (symbolOrAsset === 'base' || symbolOrAsset === 'GBYTE') {
    return 9;
  }

  let asset;

  if (symbolOrAsset.length === 44) {
    asset = symbolOrAsset;
  } else if (symbolOrAsset === symbolOrAsset.toUpperCase()) {
    asset = await getAssetBySymbol(symbolOrAsset, registryAddress);
    if (!asset) return null;
  } else {
    return null;
  }

  if (!(registryAddress in decimalsBySymbolOrAssetCache)) cache.decimalsBySymbolOrAsset[registryAddress] = {};

  if ((asset in decimalsBySymbolOrAssetCache[registryAddress]) && (decimalsBySymbolOrAssetCache[registryAddress][asset].ts + CACHE_LIFETIME >= Date.now())) return decimalsBySymbolOrAssetCache[registryAddress][asset].decimals;

  const descHash = await dag.readAAStateVar(registryAddress, `current_desc_${asset}`);

  if (!descHash) return 0;

  const decimals = await dag.readAAStateVar(registryAddress, `decimals_${descHash}`);

  if (typeof decimals !== 'number') {
    return 0;
  } else {
    cache.decimalsBySymbolOrAsset[registryAddress][asset] = { decimals, ts: Date.now() };
    return decimals;
  }
}

exports.getSymbolByAsset = getSymbolByAsset;
exports.getAssetBySymbol = getAssetBySymbol;
exports.getDecimalsBySymbolOrAsset = getDecimalsBySymbolOrAsset;