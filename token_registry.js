const { isValidAddress } = require('ocore/validation_utils');
const dag = require('./dag.js');

const tokenRegistryAddress = 'O6H6ZIFI57X3PLTYHOCVYPP5A553CYFQ';

async function getSymbolByAsset(asset, customTokenRegistryAddress) {
  const registryAddress = customTokenRegistryAddress || tokenRegistryAddress;

  if (asset === null || asset === 'base') {
    return 'GBYTE';
  }
  if (typeof asset !== 'string') {
    return null;
  }

  if (!isValidAddress(registryAddress)) {
    return null;
  }

  const symbol = await dag.readAAStateVar(registryAddress, `a2s_${asset}`);

  if (symbol) {
    return symbol;
  } else {
    return asset.replace(/[+=]/, '').substr(0, 6);
  }
}

async function getAssetBySymbol(symbol, customTokenRegistryAddress) {
  const registryAddress = customTokenRegistryAddress || tokenRegistryAddress;

  if (typeof symbol !== 'string') {
    return null;
  }

  if (symbol === 'GBYTE' || symbol === 'MBYTE' || symbol === 'KBYTE' || symbol === 'BYTE') {
    return 'base';
  }

  if (!isValidAddress(registryAddress)) {
    return null;
  }

  const asset = await dag.readAAStateVar(registryAddress, `s2a_${symbol}`);

  return asset || null;
}

async function getDecimalsBySymbolOrAsset(symbolOrAsset, customTokenRegistryAddress) {
  const registryAddress = customTokenRegistryAddress || tokenRegistryAddress;

  if (!isValidAddress(registryAddress)) {
    return 0
  }

  if (!symbolOrAsset) return 0;

  if (typeof symbolOrAsset !== 'string') return 0;

  if (symbolOrAsset === 'base' || symbolOrAsset === 'GBYTE') {
    return 9;
  }

  let asset;

  if (symbolOrAsset.length === 44) {
    asset = symbolOrAsset;
  } else if (symbolOrAsset === symbolOrAsset.toUpperCase()) {
    asset = await dag.readAAStateVar(registryAddress, `s2a_${symbolOrAsset}`);

    if (!asset) return 0;
  } else {
    return 0;
  }

  const descHash = await dag.readAAStateVar(registryAddress, `current_desc_${asset}`);

  if (!descHash) return 0;

  const decimals = await dag.readAAStateVar(registryAddress, `decimals_${descHash}`);

  if (typeof decimals !== 'number') {
    return 0;
  } else {
    return decimals;
  }
}

exports.getSymbolByAsset = getSymbolByAsset;
exports.getAssetBySymbol = getAssetBySymbol;
exports.getDecimalsBySymbolOrAsset = getDecimalsBySymbolOrAsset;