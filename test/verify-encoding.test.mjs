// Independent verification of lib.mjs encoding + math against the CANONICAL Uniswap Solidity code.
//   node lp-helper/test/verify-encoding.test.mjs
//
// How: a tiny Solidity harness (source below) that calls the real libraries from Uniswap/v4-core main and
// Uniswap/v4-periphery main (TickMath, SqrtPriceMath, LiquidityAmounts, PoolIdLibrary, Position, StateLibrary,
// CalldataDecoder, PositionInfoLibrary) was compiled with solc 0.8.24 (evm paris, optimizer 200) and its
// bytecode is embedded here. It is deployed on an anvil fork of Elysium (port 8567) and every lib.mjs function
// is compared against it. Then real PositionManager mints/decreases are run with ZERO slippage slack to prove
// the owed / received amounts are exact to the wei (amountMax = owed must pass, owed-1 must revert, etc.).
//
// Harness source (Harness.sol):
//   contract Harness {
//     using CalldataDecoder for bytes; using StateLibrary for IPoolManager;
//     sqrtAt(int24)->TickMath.getSqrtPriceAtTick; tickAt(uint160)->TickMath.getTickAtSqrtPrice;
//     liq0/liq1/liqAmts -> LiquidityAmounts.*; amt0/amt1 -> SqrtPriceMath.getAmount{0,1}Delta(a,b,uint128,bool);
//     poolId(PoolKey)->PoolIdLibrary.toId; posKey->Position.calculatePositionKey; infoOf->PositionInfoLibrary.initialize;
//     decRouter->decodeActionsRouterParams; decMint->decodeMintParams; decModify->decodeModifyLiquidityParams;
//     decBurn->decodeBurnParams; decPair->decodeCurrencyPair; decPairAddr->decodeCurrencyPairAndAddress;
//     slot0/liquidity/fgg/fgInside/posInfo/tickInfo/bitmap -> StateLibrary getters on IPoolManager }

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  getAddress,
  toHex,
  toFunctionSelector,
  decodeFunctionData,
  encodeAbiParameters,
  parseAbi,
  hexToBigInt,
  decodeAbiParameters,
} from 'viem';
import * as L from '../lib.mjs';

// ---- compiled Harness (solc 0.8.24, Uniswap v4-core/v4-periphery main) ----
const HARNESS_ABI = [{"type":"function","name":"amt0","inputs":[{"name":"a","type":"uint160","internalType":"uint160"},{"name":"b","type":"uint160","internalType":"uint160"},{"name":"l","type":"uint128","internalType":"uint128"},{"name":"up","type":"bool","internalType":"bool"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"pure"},{"type":"function","name":"amt1","inputs":[{"name":"a","type":"uint160","internalType":"uint160"},{"name":"b","type":"uint160","internalType":"uint160"},{"name":"l","type":"uint128","internalType":"uint128"},{"name":"up","type":"bool","internalType":"bool"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"pure"},{"type":"function","name":"bitmap","inputs":[{"name":"pm","type":"address","internalType":"address"},{"name":"id","type":"bytes32","internalType":"bytes32"},{"name":"w","type":"int16","internalType":"int16"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"decBurn","inputs":[{"name":"d","type":"bytes","internalType":"bytes"}],"outputs":[{"name":"id","type":"uint256","internalType":"uint256"},{"name":"a0","type":"uint128","internalType":"uint128"},{"name":"a1","type":"uint128","internalType":"uint128"},{"name":"h","type":"bytes","internalType":"bytes"}],"stateMutability":"pure"},{"type":"function","name":"decMint","inputs":[{"name":"d","type":"bytes","internalType":"bytes"}],"outputs":[{"name":"k","type":"tuple","internalType":"struct PoolKey","components":[{"name":"currency0","type":"address","internalType":"Currency"},{"name":"currency1","type":"address","internalType":"Currency"},{"name":"fee","type":"uint24","internalType":"uint24"},{"name":"tickSpacing","type":"int24","internalType":"int24"},{"name":"hooks","type":"address","internalType":"contract IHooks"}]},{"name":"l","type":"int24","internalType":"int24"},{"name":"u","type":"int24","internalType":"int24"},{"name":"liq","type":"uint256","internalType":"uint256"},{"name":"m0","type":"uint128","internalType":"uint128"},{"name":"m1","type":"uint128","internalType":"uint128"},{"name":"o","type":"address","internalType":"address"},{"name":"h","type":"bytes","internalType":"bytes"}],"stateMutability":"pure"},{"type":"function","name":"decModify","inputs":[{"name":"d","type":"bytes","internalType":"bytes"}],"outputs":[{"name":"id","type":"uint256","internalType":"uint256"},{"name":"liq","type":"uint256","internalType":"uint256"},{"name":"a0","type":"uint128","internalType":"uint128"},{"name":"a1","type":"uint128","internalType":"uint128"},{"name":"h","type":"bytes","internalType":"bytes"}],"stateMutability":"pure"},{"type":"function","name":"decPair","inputs":[{"name":"d","type":"bytes","internalType":"bytes"}],"outputs":[{"name":"c0","type":"address","internalType":"address"},{"name":"c1","type":"address","internalType":"address"}],"stateMutability":"pure"},{"type":"function","name":"decPairAddr","inputs":[{"name":"d","type":"bytes","internalType":"bytes"}],"outputs":[{"name":"c0","type":"address","internalType":"address"},{"name":"c1","type":"address","internalType":"address"},{"name":"r","type":"address","internalType":"address"}],"stateMutability":"pure"},{"type":"function","name":"decRouter","inputs":[{"name":"d","type":"bytes","internalType":"bytes"}],"outputs":[{"name":"actions","type":"bytes","internalType":"bytes"},{"name":"params","type":"bytes[]","internalType":"bytes[]"}],"stateMutability":"pure"},{"type":"function","name":"fgInside","inputs":[{"name":"pm","type":"address","internalType":"address"},{"name":"id","type":"bytes32","internalType":"bytes32"},{"name":"l","type":"int24","internalType":"int24"},{"name":"u","type":"int24","internalType":"int24"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"},{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"fgg","inputs":[{"name":"pm","type":"address","internalType":"address"},{"name":"id","type":"bytes32","internalType":"bytes32"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"},{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"infoOf","inputs":[{"name":"k","type":"tuple","internalType":"struct PoolKey","components":[{"name":"currency0","type":"address","internalType":"Currency"},{"name":"currency1","type":"address","internalType":"Currency"},{"name":"fee","type":"uint24","internalType":"uint24"},{"name":"tickSpacing","type":"int24","internalType":"int24"},{"name":"hooks","type":"address","internalType":"contract IHooks"}]},{"name":"l","type":"int24","internalType":"int24"},{"name":"u","type":"int24","internalType":"int24"}],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"pure"},{"type":"function","name":"liq0","inputs":[{"name":"a","type":"uint160","internalType":"uint160"},{"name":"b","type":"uint160","internalType":"uint160"},{"name":"x","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"","type":"uint128","internalType":"uint128"}],"stateMutability":"pure"},{"type":"function","name":"liq1","inputs":[{"name":"a","type":"uint160","internalType":"uint160"},{"name":"b","type":"uint160","internalType":"uint160"},{"name":"x","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"","type":"uint128","internalType":"uint128"}],"stateMutability":"pure"},{"type":"function","name":"liqAmts","inputs":[{"name":"p","type":"uint160","internalType":"uint160"},{"name":"a","type":"uint160","internalType":"uint160"},{"name":"b","type":"uint160","internalType":"uint160"},{"name":"x0","type":"uint256","internalType":"uint256"},{"name":"x1","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"","type":"uint128","internalType":"uint128"}],"stateMutability":"pure"},{"type":"function","name":"liquidity","inputs":[{"name":"pm","type":"address","internalType":"address"},{"name":"id","type":"bytes32","internalType":"bytes32"}],"outputs":[{"name":"","type":"uint128","internalType":"uint128"}],"stateMutability":"view"},{"type":"function","name":"poolId","inputs":[{"name":"k","type":"tuple","internalType":"struct PoolKey","components":[{"name":"currency0","type":"address","internalType":"Currency"},{"name":"currency1","type":"address","internalType":"Currency"},{"name":"fee","type":"uint24","internalType":"uint24"},{"name":"tickSpacing","type":"int24","internalType":"int24"},{"name":"hooks","type":"address","internalType":"contract IHooks"}]}],"outputs":[{"name":"","type":"bytes32","internalType":"bytes32"}],"stateMutability":"pure"},{"type":"function","name":"posInfo","inputs":[{"name":"pm","type":"address","internalType":"address"},{"name":"id","type":"bytes32","internalType":"bytes32"},{"name":"o","type":"address","internalType":"address"},{"name":"l","type":"int24","internalType":"int24"},{"name":"u","type":"int24","internalType":"int24"},{"name":"s","type":"bytes32","internalType":"bytes32"}],"outputs":[{"name":"","type":"uint128","internalType":"uint128"},{"name":"","type":"uint256","internalType":"uint256"},{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"posKey","inputs":[{"name":"o","type":"address","internalType":"address"},{"name":"l","type":"int24","internalType":"int24"},{"name":"u","type":"int24","internalType":"int24"},{"name":"s","type":"bytes32","internalType":"bytes32"}],"outputs":[{"name":"","type":"bytes32","internalType":"bytes32"}],"stateMutability":"pure"},{"type":"function","name":"slot0","inputs":[{"name":"pm","type":"address","internalType":"address"},{"name":"id","type":"bytes32","internalType":"bytes32"}],"outputs":[{"name":"p","type":"uint160","internalType":"uint160"},{"name":"t","type":"int24","internalType":"int24"},{"name":"pf","type":"uint24","internalType":"uint24"},{"name":"lf","type":"uint24","internalType":"uint24"}],"stateMutability":"view"},{"type":"function","name":"sqrtAt","inputs":[{"name":"t","type":"int24","internalType":"int24"}],"outputs":[{"name":"","type":"uint160","internalType":"uint160"}],"stateMutability":"pure"},{"type":"function","name":"tickAt","inputs":[{"name":"p","type":"uint160","internalType":"uint160"}],"outputs":[{"name":"","type":"int24","internalType":"int24"}],"stateMutability":"pure"},{"type":"function","name":"tickInfo","inputs":[{"name":"pm","type":"address","internalType":"address"},{"name":"id","type":"bytes32","internalType":"bytes32"},{"name":"t","type":"int24","internalType":"int24"}],"outputs":[{"name":"","type":"uint128","internalType":"uint128"},{"name":"","type":"int128","internalType":"int128"},{"name":"","type":"uint256","internalType":"uint256"},{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"}];
const HARNESS_BYTECODE = '0x608060405234801561001057600080fd5b5061235c806100206000396000f3fe608060405234801561001057600080fd5b506004361061014c5760003560e01c80636da956e8116100c3578063b29597181161007c578063b2959718146103b8578063cbaabd85146103eb578063cf33919514610428578063d35ec0c01461043b578063d85e297a1461044e578063f785262b1461047957600080fd5b80636da956e8146102eb5780636fed29501461030e5780637d41c9ec146103215780637d6c4a711461036c578063884d63df1461037f578063a12f42bf1461039257600080fd5b806345c238741161011557806345c238741461022a57806353470b811461024b57806353e579bf1461028b5780636a6b23581461029e5780636b35bb6b146102c55780636cb460b4146102d857600080fd5b8062021a75146101515780630a21dbb11461017e5780632641fc7e146101a957806328367ae6146101e15780632836fe1614610209575b600080fd5b61016461015f366004611b31565b61048c565b604051610175959493929190611be9565b60405180910390f35b61019161018c366004611c39565b610505565b6040516001600160801b039091168152602001610175565b6101bc6101b7366004611c8c565b61051c565b604080516001600160801b039094168452602084019290925290820152606001610175565b6101f46101ef366004611cf6565b610549565b60408051928352602083019190915201610175565b61021c610217366004611d45565b61056e565b604051908152602001610175565b61023d610238366004611b31565b610585565b604051610175929190611db2565b61025e610259366004611e24565b6106bf565b604080516001600160801b039095168552600f9390930b6020850152918301526060820152608001610175565b61021c610299366004611ea9565b6106e9565b6102b16102ac366004611b31565b6106f7565b604051610175989796959493929190611f47565b6101916102d336600461200a565b6107be565b6101f46102e636600461200a565b6107d3565b6102fe6102f9366004611b31565b6107f5565b6040516101759493929190612036565b61021c61031c366004611d45565b610850565b61033461032f36600461200a565b61085e565b604080516001600160a01b03909516855260029390930b602085015262ffffff91821692840192909252166060820152608001610175565b61021c61037a366004612068565b610886565b61021c61038d3660046120b5565b6108c1565b6103a56103a03660046120f7565b6108dc565b60405160029190910b8152602001610175565b6103cb6103c6366004611b31565b6108e7565b604080516001600160a01b03938416815292909116602083015201610175565b6103fe6103f9366004611b31565b610904565b604080516001600160a01b0394851681529284166020840152921691810191909152606001610175565b610191610436366004611c39565b610928565b61021c610449366004612114565b610935565b61046161045c36600461215d565b61094b565b6040516001600160a01b039091168152602001610175565b610191610487366004612178565b610956565b600080600080606061049e878761096f565b81818080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f820116905080830192505050505050509050905080955081965082975083985084995050505050509295509295909350565b600061051284848461099d565b90505b9392505050565b600080806105376001600160a01b038a168989898989610a00565b92509250925096509650969350505050565b6000806105616001600160a01b038716868686610a58565b9150915094509492505050565b600061057c85858585610af9565b95945050505050565b6060803660003660006105988888610b47565b935093509350935083838080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929850839250505067ffffffffffffffff8111156105f3576105f3611e62565b60405190808252806020026020018201604052801561062657816020015b60608152602001906001900390816106115790505b50945060005b818110156106b357828282818110610646576106466121d3565b905060200281019061065891906121e9565b8080601f01602080910402602001604051908101604052809392919081815260200183838082843760009201919091525050885189925084915081106106a0576106a06121d3565b602090810291909101015260010161062c565b50505050509250929050565b60008080806106d86001600160a01b0388168787610bf3565b935093509350935093509350935093565b60a081206000905b92915050565b6040805160a08101825260008082526020820181905291810182905260608101829052608081019190915260008060008060008060606107378a8a610cb1565b610746368a90038a018a611ea9565b985081818080601f016020809104026020016040519081016040528093929190818152602001838380828437600081840152601f19601f8201169050808301925050505050505090509050809850819950829a50839b50849c50859d50869e50879f5050505050505050509295985092959890939650565b60006105156001600160a01b03841683610cf3565b6000806107e96001600160a01b03851684610d7a565b915091505b9250929050565b600080600060606108068686610e2b565b81818080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250979e969d50949b5090995093975050505050505050565b600061057c85858585610e54565b60008080806108766001600160a01b03871686610f22565b9299919850965090945092505050565b60408051602681018390526006810184905260038101859052858152603a600c8201206000928201839052602082018390529082905261057c565b60006105126108d536869003860186611ea9565b8484610fda565b60006106f182611013565b6000806000806108f786866112a5565b9097909650945050505050565b60008060008060008061091788886112cf565b919a90995090975095505050505050565b6000610512848484611300565b60006105126001600160a01b038516848461133d565b60006106f1826113f6565b600061096586868686866116b1565b9695505050505050565b813560208301356040840135606085013536600061098f88886004611769565b915091509295509295509295565b6000826001600160a01b0316846001600160a01b031611156109bd579192915b60006109e0856001600160a01b0316856001600160a01b0316600160601b6117ac565b905061057c6109fb84838888036001600160a01b03166117ac565b61184e565b60408051602681018390526006810184905260038101859052858152603a600c8201206000928201839052602082018390529082905281908190610a458a8a83611874565b919c909b50909950975050505050505050565b600080600080610a688888610d7a565b91509150600080610a7a8a8a8a61191e565b91509150600080610a8c8c8c8b61191e565b915091506000610a9c8d8d610f22565b50509150508a60020b8160020b1215610abe5782850398508184039750610ae9565b8960020b8160020b12610ada5784830398508382039750610ae9565b82858803039850818487030397505b5050505050505094509492505050565b60006001600160a01b038481169086160360ff81901d90810118600160601b6001600160801b038516610b2d8184846117ac565b935084600083858409111684019350505050949350505050565b366000366000604086351860608701945063ffffffff6040880135169350606063ffffffe0601f860116018060208901351882179150808801905063ffffffff8135169250602081019350508160051b8060005b82811015610bca57858101358281189490941793860135601f0163ffffffe01690910160209081019101610b9b565b5080850189890110831715610be757633b99b53d6000526004601cfd5b50505092959194509250565b6000806000806000610c058787611976565b604051631afeb18d60e11b815260048101829052600360248201529091506000906001600160a01b038a16906335fd631a90604401600060405180830381865afa158015610c57573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f19168201604052610c7f9190810190612230565b602081015160408201516060909201516001600160801b0382169c60809290921d9b5091995090975095505050505050565b8160a081013560c082013560e0830135610100840135610120850135610140860135366000610ce2898b600b611769565b915091509295985092959850929598565b600080610cff836119cc565b90506000610d0e6003836122d6565b604051631e2eaeaf60e01b8152600481018290529091506001600160a01b03861690631e2eaeaf90602401602060405180830381865afa158015610d56573d6000803e3d6000fd5b505050506040513d601f19601f8201168201806040525081019061057c91906122f7565b6000806000610d88846119cc565b90506000610d976001836122d6565b604051631afeb18d60e11b815260048101829052600260248201529091506000906001600160a01b038816906335fd631a906044015b600060405180830381865afa158015610dea573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f19168201604052610e129190810190612230565b6020810151604090910151909890975095505050505050565b813560208301356040840135366000610e4687876003611769565b915091509295509295909350565b6000836001600160a01b0316856001600160a01b03161115610e74579293925b6001600160a01b038516610e8f5762bfc9216000526004601cfd5b6fffffffffffffffffffffffffffffffff60601b606084901b166001600160a01b038686031683610eeb57866001600160a01b0316610ed88383896001600160a01b03166117ac565b81610ee557610ee5612310565b04610f17565b610f17610f028383896001600160a01b0316611a09565b886001600160a01b0316808204910615150190565b979650505050505050565b6000806000806000610f33866119cc565b604051631e2eaeaf60e01b8152600481018290529091506000906001600160a01b03891690631e2eaeaf90602401602060405180830381865afa158015610f7e573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190610fa291906122f7565b90506001600160a01b03811695508060a01c60020b945062ffffff8160b81c16935062ffffff8160d01c169250505092959194509250565b600080610fe88560a0902090565b90508362ffffff1660081b8362ffffff1660201b8266ffffffffffffff191617179150509392505050565b600073fffd8963efd1fc6a506488495d951d51639616826401000276a21983016001600160a01b03161115611053576110536318521d4960e21b83611a3b565b640100000000600160c01b03602083901b1680600061107182611a52565b60ff1690506080811061108c57607f810383901c9150611096565b80607f0383901b91505b908002607f81811c60ff83811c9190911c800280831c81831c1c800280841c81841c1c800280851c81851c1c800280861c81861c1c800280871c81871c1c800280881c81881c1c800280891c81891c1c8002808a1c818a1c1c8002808b1c818b1c1c8002808c1c818c1c1c8002808d1c818d1c1c8002808e1c9c81901c9c909c1c80029c8d901c9e9d607f198f0160401b60c09190911c678000000000000000161760c19b909b1c674000000000000000169a909a1760c29990991c672000000000000000169890981760c39790971c671000000000000000169690961760c49590951c670800000000000000169490941760c59390931c670400000000000000169290921760c69190911c670200000000000000161760c79190911c670100000000000000161760c89190911c6680000000000000161760c99190911c6640000000000000161760ca9190911c6620000000000000161760cb9190911c6610000000000000161760cc9190911c6608000000000000161760cd9190911c66040000000000001617693627a301d71055774c8581026f028f6481ab7f045a5af012a19d003aa9198101608090811d906fdb2df09e81959a81455e260799a0632f8301901d600281810b9083900b1461129657886001600160a01b031661127b826113f6565b6001600160a01b031611156112905781611298565b80611298565b815b9998505050505050505050565b60008060408310156112bf57633b99b53d6000526004601cfd5b5050813592602090920135919050565b600080600060608410156112eb57633b99b53d6000526004601cfd5b50508235936020840135936040013592509050565b6000826001600160a01b0316846001600160a01b03161115611320579192915b6105126109fb83600160601b8787036001600160a01b03166117ac565b600080611349846119cc565b905060006113586005836122d6565b60408051600187900b602082015290810182905290915060009060600160408051808303601f19018152908290528051602090910120631e2eaeaf60e01b82526004820181905291506001600160a01b03881690631e2eaeaf90602401602060405180830381865afa1580156113d2573d6000803e3d6000fd5b505050506040513d601f19601f82011682018060405250810190610f1791906122f7565b60020b600060ff82901d80830118620d89e8811115611420576114206345c3193d60e11b84611adf565b7001fffcb933bd6fad37aa2d162d1a5940016001821602600160801b18600282161561145c576ffff97272373d413259a46990580e213a0260801c5b600482161561147b576ffff2e50f5f656932ef12357cf3c7fdcc0260801c5b600882161561149a576fffe5caca7e10e4e61c3624eaa0941cd00260801c5b60108216156114b9576fffcb9843d60f6159c9db58835c9266440260801c5b60208216156114d8576fff973b41fa98c081472e6896dfb254c00260801c5b60408216156114f7576fff2ea16466c96a3843ec78b326b528610260801c5b6080821615611516576ffe5dee046a99a2a811c461f1969c30530260801c5b610100821615611536576ffcbe86c7900a88aedcffc83b479aa3a40260801c5b610200821615611556576ff987a7253ac413176f2b074cf7815e540260801c5b610400821615611576576ff3392b0822b70005940c7a398e4b70f30260801c5b610800821615611596576fe7159475a2c29b7443b29c7fa6e889d90260801c5b6110008216156115b6576fd097f3bdfd2022b8845ad8f792aa58250260801c5b6120008216156115d6576fa9f746462d870fdf8a65dc1f90e061e50260801c5b6140008216156115f6576f70d869a156d2a1b890bb3df62baf32f70260801c5b618000821615611616576f31be135f97d08fd981231505542fcfa60260801c5b62010000821615611637576f09aa508b5b7a84e1c677de54f3e99bc90260801c5b62020000821615611657576e5d6af8dedb81196699c329225ee6040260801c5b62040000821615611676576d2216e584f5fa1ea926041bedfe980260801c5b62080000821615611693576b048a170391f7dc42444e8fa20260801c5b60008413156116a157600019045b63ffffffff0160201c9392505050565b6000836001600160a01b0316856001600160a01b031611156116d1579293925b846001600160a01b0316866001600160a01b0316116116fc576116f585858561099d565b905061057c565b836001600160a01b0316866001600160a01b0316101561175e57600061172387868661099d565b90506000611732878986611300565b9050806001600160801b0316826001600160801b0316106117535780611755565b815b9250505061057c565b610965858584611300565b63ffffffff600582901b84013581168401602081810192823516918291849183010186880110156117a257633b99b53d6000526004601cfd5b5050935093915050565b600083830281600019858709828110838203039150508084116117ce57600080fd5b806000036117e157508290049050610515565b6000848688096000868103871696879004966002600389028118808a02820302808a02820302808a02820302808a02820302808a02820302808a02909103029181900381900460010186841190950394909402919094039290920491909117919091029150509392505050565b806001600160801b038116811461186f5761186f6393dafdf160e01b611af0565b919050565b6000806000806118848686611afa565b604051631afeb18d60e11b815260048101829052600360248201529091506000906001600160a01b038916906335fd631a90604401600060405180830381865afa1580156118d6573d6000803e3d6000fd5b505050506040513d6000823e601f3d908101601f191682016040526118fe9190810190612230565b60208101516040820151606090920151909a919950975095505050505050565b600080600061192d8585611976565b905060006001600160a01b0387166335fd631a61194b8460016122d6565b60405160e083901b6001600160e01b0319168152600481019190915260026024820152604401610dcd565b600080611982846119cc565b905060006119916004836122d6565b60408051600287900b60208201529081018290529091506060015b604051602081830303815290604052805190602001209250505092915050565b6040516000906119ec908390600690602001918252602082015260400190565b604051602081830303815290604052805190602001209050919050565b6000611a168484846117ac565b90508180611a2657611a26612310565b83850915610515576001018061051557600080fd5b816000526001600160a01b03811660045260246000fd5b6000808211611a6057600080fd5b507f0706060506020500060203020504000106050205030304010505030400000000601f6f8421084210842108cc6318c6db6d54be6001600160801b03841160071b84811c67ffffffffffffffff1060061b1784811c63ffffffff1060051b1784811c61ffff1060041b1784811c60ff1060031b1793841c1c161a1790565b816000528060020b60045260246000fd5b8060005260046000fd5b600080611b06846119cc565b90506000611b156006836122d6565b60408051602081018790529081018290529091506060016119ac565b60008060208385031215611b4457600080fd5b823567ffffffffffffffff80821115611b5c57600080fd5b818501915085601f830112611b7057600080fd5b813581811115611b7f57600080fd5b866020828501011115611b9157600080fd5b60209290920196919550909350505050565b6000815180845260005b81811015611bc957602081850181015186830182015201611bad565b506000602082860101526020601f19601f83011685010191505092915050565b85815284602082015260006001600160801b03808616604084015280851660608401525060a06080830152610f1760a0830184611ba3565b6001600160a01b0381168114611c3657600080fd5b50565b600080600060608486031215611c4e57600080fd5b8335611c5981611c21565b92506020840135611c6981611c21565b929592945050506040919091013590565b8035600281900b811461186f57600080fd5b60008060008060008060c08789031215611ca557600080fd5b8635611cb081611c21565b9550602087013594506040870135611cc781611c21565b9350611cd560608801611c7a565b9250611ce360808801611c7a565b915060a087013590509295509295509295565b60008060008060808587031215611d0c57600080fd5b8435611d1781611c21565b935060208501359250611d2c60408601611c7a565b9150611d3a60608601611c7a565b905092959194509250565b60008060008060808587031215611d5b57600080fd5b8435611d6681611c21565b93506020850135611d7681611c21565b925060408501356001600160801b0381168114611d9257600080fd5b915060608501358015158114611da757600080fd5b939692955090935050565b604081526000611dc56040830185611ba3565b6020838203818501528185518084528284019150828160051b85010183880160005b83811015611e1557601f19878403018552611e03838351611ba3565b94860194925090850190600101611de7565b50909998505050505050505050565b600080600060608486031215611e3957600080fd5b8335611e4481611c21565b925060208401359150611e5960408501611c7a565b90509250925092565b634e487b7160e01b600052604160045260246000fd5b604051601f8201601f1916810167ffffffffffffffff81118282101715611ea157611ea1611e62565b604052919050565b600060a08284031215611ebb57600080fd5b60405160a0810181811067ffffffffffffffff82111715611ede57611ede611e62565b6040528235611eec81611c21565b81526020830135611efc81611c21565b6020820152604083013562ffffff81168114611f1757600080fd5b6040820152611f2860608401611c7a565b60608201526080830135611f3b81611c21565b60808201529392505050565b600061018060018060a01b03808c511684528060208d015116602085015262ffffff60408d015116604085015260608c015160020b60608501528060808d015116608085015250611f9d60a084018b60020b9052565b611fac60c084018a60020b9052565b8760e0840152611fc86101008401886001600160801b03169052565b6001600160801b0386166101208401526001600160a01b03851661014084015280610160840152611ffb81840185611ba3565b9b9a5050505050505050505050565b6000806040838503121561201d57600080fd5b823561202881611c21565b946020939093013593505050565b84815260006001600160801b038086166020840152808516604084015250608060608301526109656080830184611ba3565b6000806000806080858703121561207e57600080fd5b843561208981611c21565b935061209760208601611c7a565b92506120a560408601611c7a565b9396929550929360600135925050565b600080600083850360e08112156120cb57600080fd5b60a08112156120d957600080fd5b508392506120e960a08501611c7a565b9150611e5960c08501611c7a565b60006020828403121561210957600080fd5b813561051581611c21565b60008060006060848603121561212957600080fd5b833561213481611c21565b9250602084013591506040840135600181900b811461215257600080fd5b809150509250925092565b60006020828403121561216f57600080fd5b61051582611c7a565b600080600080600060a0868803121561219057600080fd5b853561219b81611c21565b945060208601356121ab81611c21565b935060408601356121bb81611c21565b94979396509394606081013594506080013592915050565b634e487b7160e01b600052603260045260246000fd5b6000808335601e1984360301811261220057600080fd5b83018035915067ffffffffffffffff82111561221b57600080fd5b6020019150368190038213156107ee57600080fd5b6000602080838503121561224357600080fd5b825167ffffffffffffffff8082111561225b57600080fd5b818501915085601f83011261226f57600080fd5b81518181111561228157612281611e62565b8060051b9150612292848301611e78565b81815291830184019184810190888411156122ac57600080fd5b938501935b838510156122ca578451825293850193908501906122b1565b98975050505050505050565b808201808211156106f157634e487b7160e01b600052601160045260246000fd5b60006020828403121561230957600080fd5b5051919050565b634e487b7160e01b600052601260045260246000fdfea264697066735822122024f5e924f46f0388056a2862a0de78e807b78f84df84e2433348e1bd06b7f1bd64736f6c63430008180033';


const PORT = 8567;
const FORK_RPC = `http://127.0.0.1:${PORT}`;
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) failed++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const log = (...a) => console.log('•', ...a);

// deterministic PRNG
let seed = 0x1234567n;
function rnd(bits) {
  let x = 0n;
  for (let i = 0; i < Math.ceil(bits / 32); i++) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    x = (x << 32n) | (seed >> 32n);
  }
  return x & ((1n << BigInt(bits)) - 1n);
}
const rndInt = (lo, hi) => lo + Number(rnd(32) % BigInt(hi - lo + 1));

async function rpcReachable(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: ctl.signal });
    clearTimeout(t);
    return Number((await r.json()).result) === L.CHAIN_ID;
  } catch {
    return false;
  }
}
function findAnvil() {
  const local = join(homedir(), '.foundry', 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
  return existsSync(local) ? local : 'anvil';
}
async function startAnvil() {
  const proc = spawn(findAnvil(), ['--fork-url', L.RPC_URL, '--port', String(PORT), '--chain-id', String(L.CHAIN_ID), '--silent'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null) throw new Error('anvil exited: ' + stderr);
    if (await rpcReachable(FORK_RPC)) {
      await fetch(FORK_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }) });
      return proc;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill();
  throw new Error('anvil did not start');
}

// ------------------------------------------------------------------ pure (no chain) checks
async function staticChecks() {
  console.log('-- static / source checks --');
  // Actions.sol from GitHub (if reachable)
  try {
    const src = await (await fetch('https://raw.githubusercontent.com/Uniswap/v4-periphery/main/src/libraries/Actions.sol')).text();
    const m = Object.fromEntries([...src.matchAll(/constant\s+(\w+)\s*=\s*(0x[0-9a-fA-F]+)/g)].map((x) => [x[1], Number(x[2])]));
    for (const [k, v] of Object.entries(L.ACTIONS)) check(`Actions.${k} == Actions.sol (${toHex(m[k] ?? -1)})`, m[k] === v, `lib ${toHex(v)}`);
  } catch (e) {
    log('could not fetch Actions.sol, skipping source compare', e.message);
  }
  // TAKE (tool fee): byte, param layout and the meaning of amount 0, from the canonical sources. Checked on main and on
  // 545a5d2 (the v4-periphery commit the deployed UniversalRouter 2.1.2 pins).
  for (const ref of ['main', '545a5d2']) {
    const base = `https://raw.githubusercontent.com/Uniswap/v4-periphery/${ref}/src`;
    let src;
    try {
      const get = async (p) => { const r = await fetch(`${base}/${p}`); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.text(); };
      src = {
        actions: await get('libraries/Actions.sol'),
        posm: await get('PositionManager.sol'),
        dec: await get('libraries/CalldataDecoder.sol'),
        consts: await get('libraries/ActionConstants.sol'),
        delta: await get('base/DeltaResolver.sol'),
      };
    } catch (e) {
      log(`could not fetch v4-periphery@${ref} sources, skipping TAKE source checks`, e.message);
      continue;
    }
    const flat = (s) => s.replace(/\s+/g, ' ');
    check(`[${ref}] Actions.sol: TAKE = 0x0e == lib ACTIONS.TAKE; TAKE_PAIR = 0x11`, /uint256 internal constant TAKE = 0x0e;/.test(src.actions) && /uint256 internal constant TAKE_PAIR = 0x11;/.test(src.actions) && L.ACTIONS.TAKE === 0x0e && L.ACTIONS.TAKE_PAIR === 0x11);
    check(`[${ref}] PositionManager._handleAction: TAKE -> decodeCurrencyAddressAndUint256 -> _take(currency, _mapRecipient(recipient), _mapTakeAmount(amount, currency))`,
      flat(src.posm).includes('action == Actions.TAKE) { (Currency currency, address recipient, uint256 amount) = params.decodeCurrencyAddressAndUint256(); _take(currency, _mapRecipient(recipient), _mapTakeAmount(amount, currency));'));
    check(`[${ref}] PositionManager: TAKE_PAIR -> decodeCurrencyPairAndAddress -> _takePair = _take(c, to, _getFullCredit(c)) for both`,
      flat(src.posm).includes('action == Actions.TAKE_PAIR) { (Currency currency0, Currency currency1, address recipient) = params.decodeCurrencyPairAndAddress(); _takePair(currency0, currency1, _mapRecipient(recipient));') &&
      flat(src.posm).includes('_take(currency0, recipient, _getFullCredit(currency0)); _take(currency1, recipient, _getFullCredit(currency1));'));
    const m = flat(src.dec).match(/equivalent to: abi\.decode\(params, \(Currency, address, uint256\)\) in calldata function decodeCurrencyAddressAndUint256\(bytes calldata params\) internal pure returns \(Currency currency, address _address, uint256 amount\) \{ assembly \("memory-safe"\) \{ if lt\(params\.length, 0x60\) \{[^}]*\} currency := calldataload\(params\.offset\) _address := calldataload\(add\(params\.offset, 0x20\)\) amount := calldataload\(add\(params\.offset, 0x40\)\)/);
    const enc = L.encodeTake(L.ADDR.KNTQ, L.FEE_RECIPIENT, 123456789n);
    const word = (i) => BigInt('0x' + enc.slice(2 + 64 * i, 66 + 64 * i));
    check(`[${ref}] CalldataDecoder.decodeCurrencyAddressAndUint256 = (Currency @0x00, address @0x20, uint256 @0x40), min 0x60 bytes; lib encodeTake writes exactly those 3 words`,
      !!m && enc.length === 2 + 3 * 64 && word(0) === BigInt(L.ADDR.KNTQ) && word(1) === BigInt(L.FEE_RECIPIENT) && word(2) === 123456789n);
    check(`[${ref}] ActionConstants.OPEN_DELTA = 0 and DeltaResolver._mapTakeAmount(OPEN_DELTA) = _getFullCredit (TAKE amount 0 = the WHOLE credit)`,
      /uint128 internal constant OPEN_DELTA = 0;/.test(src.consts) && flat(src.delta).includes('function _mapTakeAmount(uint256 amount, Currency currency) internal view returns (uint256) { if (amount == ActionConstants.OPEN_DELTA) { return _getFullCredit(currency);'));
    check(`[${ref}] DeltaResolver._getFullCredit reverts DeltaNotPositive on a negative delta (a fee TAKE larger than the credited fees makes the guarding TAKE_PAIR revert the whole tx)`, flat(src.delta).includes('if (_amount < 0) revert DeltaNotPositive(currency);'));
    check(`[${ref}] DeltaResolver._take returns early on amount 0 (a second TAKE_PAIR with nothing left is a no-op; it takes whatever credit re-accrued)`, /function _take\(Currency currency, address recipient, uint256 amount\) internal (virtual )?\{ if \(amount == 0\) return; poolManager\.take\(currency, recipient, amount\); \}/.test(flat(src.delta)));
    check(`[${ref}] PositionManager._decrease: slippage mins checked on liquidityDelta - feesAccrued (the principal; 0 fees after a DECREASE(0))`, flat(src.posm).includes('(liquidityDelta - feesAccrued).validateMinOut(amount0Min, amount1Min);'));
    check(`[${ref}] PositionManager._burn: only calls the pool when liquidity > 0 (BURN after DECREASE(all) moves nothing)`, /uint256 liquidity = uint256\(_getLiquidity\(tokenId, poolKey, info\.tickLower\(\), info\.tickUpper\(\)\)\);[\s\S]{0,400}if \(liquidity > 0\) \{/.test(src.posm));
  }
  check('lib encodeTake refuses amount 0 (never encodes OPEN_DELTA)', (() => { try { L.encodeTake(L.ADDR.USDC, L.FEE_RECIPIENT, 0n); return false; } catch { return true; } })());
  {
    let ok = true;
    for (const a of [0n, 1n, 9n, 10n, 11n, 99n, 12345n, 10n ** 18n]) for (const b of [0n, 5n, 10n, 10n ** 20n + 1n]) for (const pool of ['USDC', 'HYPE']) {
      const fees = { amount0: a, amount1: b };
      for (const r of [L.buildCollect({ tokenId: 1n, recipient: L.ADDR.USDC, deadline: 1n, expectedFees: fees, pool }), L.buildDecrease({ tokenId: 1n, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, recipient: L.ADDR.USDC, deadline: 1n, burn: true, expected: { amount0: 0n, amount1: 0n, fees }, pool })]) {
        const [acts, ps] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], r.args[0]);
        const as = [...Buffer.from(acts.slice(2), 'hex')];
        as.forEach((x, i) => {
          if (x !== 0x0e) return;
          const [, rcp, amt] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], ps[i]);
          if (amt === 0n || getAddress(rcp) !== L.FEE_RECIPIENT) ok = false;
        });
        if (as.at(-1) !== 0x11) ok = false;
      }
    }
    check('builders never encode a TAKE with amount 0; every TAKE goes to FEE_RECIPIENT; TAKE_PAIR is last', ok);
  }
  // Permit2 selectors (AllowanceTransfer: approve(address,address,uint160,uint48), allowance(address,address,address))
  const sel = (n) => toFunctionSelector(L.PERMIT2_ABI.find((x) => x.name === n));
  check('Permit2.approve selector == approve(address,address,uint160,uint48)', sel('approve') === toFunctionSelector('approve(address,address,uint160,uint48)'), sel('approve'));
  check('Permit2.allowance selector == allowance(address,address,address)', sel('allowance') === toFunctionSelector('allowance(address,address,address)'), sel('allowance'));
  check('modifyLiquidities selector == 0xdd46508f', toFunctionSelector(L.POSM_ABI.find((x) => x.name === 'modifyLiquidities')) === '0xdd46508f');

  // tick alignment incl negative ticks
  const cases = [
    [() => L.floorTick(-150), -200], [() => L.ceilTick(-150), 0], [() => L.floorTick(-400), -400], [() => L.ceilTick(-401), -400],
    [() => L.floorTick(-401), -600], [() => L.floorTick(150), 0], [() => L.ceilTick(150), 200], [() => L.floorTick(286928), 286800],
    [() => L.ceilTick(286928), 287000], [() => L.MIN_USABLE_TICK, -887200], [() => L.MAX_USABLE_TICK, 887200],
  ];
  let ok = true;
  for (const [f, e] of cases) if (f() !== e) { ok = false; log('alignment mismatch', f.toString(), f(), e); }
  check('floorTick/ceilTick incl. negative ticks', ok);
  // -0 from ceilTick must still encode/validate fine
  let negZeroOk = true;
  try { L.validateTicks(L.ceilTick(-150), 200); L.validateTicks(-200, L.ceilTick(-150)); L.encodeMintParams({ tickLower: L.ceilTick(-150), tickUpper: 200, liquidity: 1n, amount0Max: 0n, amount1Max: 0n, owner: L.ADDR.USDC }); } catch (e) { negZeroOk = false; log(e.message); }
  check('ceilTick(-150) = -0 still validates and encodes', negZeroOk);

  // range presets: aligned, ordered, bracket the requested USD band outward, contain current tick
  let rOk = true;
  for (const cur of [286928, 286457, 286800, 287000, 100, -100, -286928, 0]) {
    for (const [p, pct] of [['pm20', 0.2], ['pm50', 0.5], ['pm80', 0.8]]) {
      const { tickLower, tickUpper } = L.rangeForPreset(p, cur);
      const usd = L.tickToUsdPerKntq(cur);
      const d = L.describeRange(tickLower, tickUpper);
      const good = tickLower % 200 === 0 && tickUpper % 200 === 0 && tickLower < tickUpper && tickLower <= cur && cur < tickUpper &&
        d.minUsdPerKntq <= usd * (1 - pct) * (1 + 1e-9) && d.maxUsdPerKntq >= usd * (1 + pct) * (1 - 1e-9);
      if (!good) { rOk = false; log('preset mismatch', p, cur, tickLower, tickUpper, d, usd); }
    }
  }
  check('±20/50/80% presets: aligned, contain current tick, round outward in USD', rOk);
  const c = L.rangeForPreset('custom', 286928, { minUsd: 0.2, maxUsd: 0.5 });
  const dc = L.describeRange(c.tickLower, c.tickUpper);
  check('custom $0.2–$0.5 -> ticks bracket outward', dc.minUsdPerKntq <= 0.2 * (1 + 1e-4) && dc.maxUsdPerKntq >= 0.5 * (1 - 1e-4), `${dc.minUsdPerKntq} – ${dc.maxUsdPerKntq}`);
  // KNTQ/HYPE 0.8% pool: spacing 120, quote = HYPE; percentages on USD/KNTQ == percentages on HYPE/KNTQ
  let hOk = true;
  for (const cur of [53258, 53266, 52000, 60000, 0, -120, 119]) {
    for (const [p, pct] of [['pm20', 0.2], ['pm50', 0.5], ['pm80', 0.8]]) {
      const { tickLower, tickUpper } = L.rangeForPreset(p, cur, {}, 'HYPE');
      const q = L.tickToQuotePerKntq(cur, 'HYPE');
      const d = L.describeRange(tickLower, tickUpper, 'HYPE', 74);
      const good = tickLower % 120 === 0 && tickUpper % 120 === 0 && tickLower <= cur && cur < tickUpper &&
        d.minQuotePerKntq <= q * (1 - pct) * (1 + 1e-9) && d.maxQuotePerKntq >= q * (1 + pct) * (1 - 1e-9) && Math.abs(d.minUsdPerKntq / d.minQuotePerKntq - 74) < 1e-9;
      if (!good) { hOk = false; log('HYPE preset mismatch', p, cur, tickLower, tickUpper); }
    }
  }
  check('HYPE pool ±20/50/80%: aligned to 120, contain tick, round outward', hOk);
  const fh = L.rangeForPreset('full', 53258, {}, 'HYPE');
  check('HYPE pool full range = ±887160 and describeRange says full', fh.tickLower === -887160 && fh.tickUpper === 887160 && L.describeRange(fh.tickLower, fh.tickUpper, 'HYPE').full);
  const ch = L.rangeForPreset('custom', 53258, { minUsd: 0.2, maxUsd: 0.5, usdPerQuote: 74 }, 'HYPE');
  const dch = L.describeRange(ch.tickLower, ch.tickUpper, 'HYPE', 74);
  check('HYPE pool custom $0.2–$0.5 at $74/HYPE -> ticks bracket outward', dch.minUsdPerKntq <= 0.2 * (1 + 1e-4) && dch.maxUsdPerKntq >= 0.5 * (1 - 1e-4) && ch.tickLower % 120 === 0, `${dch.minUsdPerKntq} – ${dch.maxUsdPerKntq}`);
  check('USDC-pool helpers unchanged: tickToQuotePerKntq == tickToUsdPerKntq', [286928, 0, -5000, 300000].every((t) => L.tickToQuotePerKntq(t, 'USDC') === L.tickToUsdPerKntq(t)));
  // planMintFromBalances: max of the limiting side, amountMax fits balances
  {
    const st = { sqrtPriceX96: L.getSqrtPriceAtTick(53258) + 777n, tick: 53258 };
    let ok = true;
    for (const [a0, a1] of [[19n * 10n ** 17n, 396n * 10n ** 18n], [10n ** 18n, 10n ** 21n], [5n * 10n ** 18n, 10n ** 18n], [1000n, 10n ** 20n]]) {
      for (const bps of [1, 50, 100, 500]) {
        const p = L.planMintFromBalances(st, -887160, 887160, { avail0: a0, avail1: a1 }, bps, 'HYPE');
        const lim = p.limiting === 'amount0' ? [p.leftover0, a0] : [p.leftover1, a1];
        if (p.amount0Max > a0 || p.amount1Max > a1 || p.amount0 > p.amount0Max || p.amount1 > p.amount1Max || lim[0] * 10000n > lim[1] * BigInt(bps + 1) + 30000n) { ok = false; log('fromBalances', a0, a1, bps, p); }
      }
    }
    check('planMintFromBalances: maxes fit balances, limiting-side leftover <= slippage share', ok);
  }

  // price inverse roundtrip
  let pOk = true;
  for (let i = 0; i < 200; i++) {
    const t = rndInt(-300000, 887000); // float path loses precision for absurd prices (tick < ~-400k, >1e28 USD/KNTQ)
    const back = L.kntqPerUsdcToTick(L.tickToKntqPerUsdc(t));
    if (Math.abs(back - t) > 1) { pOk = false; log('price roundtrip', t, back); break; }
  }
  check('kntqPerUsdcToTick(tickToKntqPerUsdc(t)) within 1 tick', pOk);
  check('tick 286928 ≈ 2.887 KNTQ/USDC', Math.abs(L.tickToKntqPerUsdc(286928) - 2.887) < 0.01, L.tickToKntqPerUsdc(286928).toFixed(4));

  // slippage direction
  let sOk = true;
  for (let i = 0; i < 300; i++) {
    const x = rnd(100);
    const bps = rndInt(0, 2000);
    const up = L.withSlippageUp(x, bps), dn = L.withSlippageDown(x, bps);
    if (up < x || dn > x || (bps === 0 && (up !== x || dn !== x))) { sOk = false; break; }
  }
  check('withSlippageUp >= x >= withSlippageDown, identity at 0 bps', sOk);
  // approvals logic
  const now = 1_700_000_000;
  check('approvalNeeds: expired permit2 -> re-approve', L.approvalNeeds(10n, 10n, { amount: 10n, expiration: now + 60 }, now).permit2 === true);
  check('approvalNeeds: sufficient -> skip both', JSON.stringify(L.approvalNeeds(10n, 10n, { amount: 10n, expiration: now + 3600 }, now)) === '{"erc20":false,"permit2":false}');
}

// ------------------------------------------------------------------ chain checks
async function run() {
  const chain = { ...L.elysium, rpcUrls: { default: { http: [FORK_RPC] } } };
  const pub = createPublicClient({ chain, transport: http(FORK_RPC), pollingInterval: 100 });
  const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_RPC) });
  const [u] = await pub.request({ method: 'eth_accounts' });
  const USER = getAddress(u);
  const wallet = createWalletClient({ chain, transport: http(FORK_RPC), account: USER });

  const dh = await wallet.deployContract({ abi: HARNESS_ABI, bytecode: HARNESS_BYTECODE, chain });
  const H = (await pub.waitForTransactionReceipt({ hash: dh })).contractAddress;
  const h = (functionName, args) => pub.readContract({ address: H, abi: HARNESS_ABI, functionName, args });
  log('harness deployed at', H);

  console.log('-- TickMath vs v4-core --');
  const ticks = [L.MIN_TICK, L.MAX_TICK, 0, 1, -1, 2, -2, 200, -200, L.MIN_USABLE_TICK, L.MAX_USABLE_TICK, 286928, 286457, 282400, 293400, -887271, 887271];
  for (let i = 0; i < 150; i++) ticks.push(rndInt(L.MIN_TICK, L.MAX_TICK));
  for (let b = 0; b < 20; b++) { ticks.push(1 << b, -(1 << b)); }
  let tm = 0;
  for (const t of ticks) {
    if (Math.abs(t) > L.MAX_TICK) continue;
    const s = await h('sqrtAt', [t]);
    if (s !== L.getSqrtPriceAtTick(t)) { tm++; log('sqrtAt mismatch', t, s, L.getSqrtPriceAtTick(t)); }
  }
  check(`getSqrtPriceAtTick == TickMath for ${ticks.length} ticks (MIN/MAX/0/±powers of 2/random)`, tm === 0);
  check('known: sqrt(MIN)=4295128739, sqrt(MAX)=1461446703485210103287273052203988822378723970342, sqrt(0)=2^96',
    L.getSqrtPriceAtTick(L.MIN_TICK) === 4295128739n && L.getSqrtPriceAtTick(L.MAX_TICK) === 1461446703485210103287273052203988822378723970342n && L.getSqrtPriceAtTick(0) === 2n ** 96n);
  let tInv = 0;
  const prices = [L.MIN_SQRT_PRICE, L.MAX_SQRT_PRICE - 1n, 2n ** 96n, 2n ** 96n - 1n];
  for (const t of ticks.slice(0, 60)) { const s = L.getSqrtPriceAtTick(t); prices.push(s); if (s > L.MIN_SQRT_PRICE) prices.push(s - 1n); if (s + 1n < L.MAX_SQRT_PRICE) prices.push(s + 1n); }
  for (let i = 0; i < 60; i++) prices.push(L.MIN_SQRT_PRICE + (rnd(160) % (L.MAX_SQRT_PRICE - L.MIN_SQRT_PRICE)));
  for (const p of prices) {
    let a, b;
    try { a = await h('tickAt', [p]); } catch { a = 'revert'; }
    try { b = L.getTickAtSqrtPrice(p); } catch { b = 'revert'; }
    if (a !== b) { tInv++; log('tickAt mismatch', p, a, b); }
  }
  check(`getTickAtSqrtPrice == TickMath for ${prices.length} prices`, tInv === 0);

  console.log('-- LiquidityAmounts / SqrtPriceMath vs canonical --');
  let lm = 0, am = 0, n = 0;
  const realistic = [L.MIN_USABLE_TICK, L.MAX_USABLE_TICK, 282400, 293400, 286800, 287000, 280000, 300000];
  for (let i = 0; i < 120; i++) {
    let ta, tb, tp;
    if (i < 60) { ta = realistic[rndInt(0, 7)]; tb = realistic[rndInt(0, 7)]; tp = rndInt(270000, 300000); }
    else { ta = rndInt(L.MIN_TICK, L.MAX_TICK); tb = rndInt(L.MIN_TICK, L.MAX_TICK); tp = rndInt(L.MIN_TICK, L.MAX_TICK); }
    if (ta === tb) continue;
    const A = L.getSqrtPriceAtTick(ta), B = L.getSqrtPriceAtTick(tb);
    const P = L.getSqrtPriceAtTick(tp) + rnd(20);
    const x0 = rnd(i < 60 ? 40 : 64), x1 = rnd(i < 60 ? 80 : 64);
    n++;
    let solL, jsL;
    try { solL = await h('liqAmts', [P, A, B, x0, x1]); } catch { solL = 'revert'; }
    try { jsL = L.getLiquidityForAmounts(P, A, B, x0, x1); } catch { jsL = 'revert'; }
    if (solL !== jsL) { lm++; log('liqAmts mismatch', { ta, tb, P, x0, x1, solL, jsL }); }
    let s0, j0; try { s0 = await h('liq0', [A, B, x0]); } catch { s0 = 'revert'; } try { j0 = L.getLiquidityForAmount0(A, B, x0); } catch { j0 = 'revert'; }
    let s1, j1; try { s1 = await h('liq1', [A, B, x1]); } catch { s1 = 'revert'; } try { j1 = L.getLiquidityForAmount1(A, B, x1); } catch { j1 = 'revert'; }
    if (s0 !== j0 || s1 !== j1) { lm++; log('liq0/1 mismatch', { s0, j0, s1, j1 }); }
    const liq = rnd(i < 60 ? 70 : 128);
    for (const up of [true, false]) {
      let a, b; try { a = await h('amt0', [A, B, liq, up]); } catch { a = 'revert'; } try { b = L.getAmount0Delta(A, B, liq, up); } catch { b = 'revert'; }
      let c, d; try { c = await h('amt1', [A, B, liq, up]); } catch { c = 'revert'; } try { d = L.getAmount1Delta(A, B, liq, up); } catch { d = 'revert'; }
      if (a !== b || c !== d) { am++; log('amountDelta mismatch', { ta, tb, liq, up, a, b, c, d }); }
    }
  }
  check(`getLiquidityForAmount{0,1,s} == LiquidityAmounts (${n} cases, incl. reverts)`, lm === 0);
  check(`getAmount{0,1}Delta both roundings == SqrtPriceMath (${n} cases)`, am === 0);

  console.log('-- PoolId / Position / PositionInfo --');
  const keyTuple = (k) => ({ currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks });
  check('poolIdOf(POOL_KEY) == PoolIdLibrary.toId == target', (await h('poolId', [keyTuple(L.POOL_KEY)])) === L.COMPUTED_POOL_ID && L.COMPUTED_POOL_ID === L.TARGET_POOL_ID);
  let pidOk = true;
  for (let i = 0; i < 10; i++) {
    const k = { currency0: getAddress(toHex(rnd(160), { size: 20 })), currency1: getAddress(toHex(rnd(160), { size: 20 })), fee: Number(rnd(24)), tickSpacing: rndInt(1, 32767), hooks: getAddress(toHex(rnd(160), { size: 20 })) };
    if ((await h('poolId', [k])) !== L.poolIdOf(k)) pidOk = false;
  }
  check('poolIdOf == PoolIdLibrary.toId on 10 random keys', pidOk);
  let pkOk = true, piOk = true;
  for (const [tl, tu] of [[-887200, 887200], [282400, 293400], [-400, -200], [-200, 0], [-886000, -885800], [0, 200]]) {
    const salt = toHex(rnd(64), { size: 32 });
    if ((await h('posKey', [L.ADDR.POSITION_MANAGER, tl, tu, salt])) !== L.positionKey(L.ADDR.POSITION_MANAGER, tl, tu, salt)) pkOk = false;
    const info = await h('infoOf', [keyTuple(L.POOL_KEY), tl, tu]);
    const d = L.decodePositionInfo(info);
    if (d.tickLower !== tl || d.tickUpper !== tu || d.hasSubscriber || d.poolId !== L.TARGET_POOL_ID.slice(0, 52)) { piOk = false; log('positionInfo decode mismatch', tl, tu, d); }
  }
  check('positionKey == Position.calculatePositionKey (incl. negative ticks)', pkOk);
  check('decodePositionInfo(PositionInfoLibrary.initialize(...)) roundtrips (incl. negative ticks; poolId = bytes25 prefix)', piOk);

  console.log('-- Calldata encoders vs CalldataDecoder --');
  const owner = USER;
  const mp = { tickLower: -887200, tickUpper: 293400, liquidity: 123456789012345678901234n, amount0Max: 2n ** 127n + 5n, amount1Max: 77n, owner, hookData: '0xdeadbeef' };
  const dm = await h('decMint', [L.encodeMintParams(mp)]);
  check('MINT_POSITION params decode (PoolKey,int24,int24,uint256,uint128,uint128,address,bytes)',
    dm[0].currency0 === L.POOL_KEY.currency0 && dm[0].currency1 === L.POOL_KEY.currency1 && dm[0].fee === 20000 && dm[0].tickSpacing === 200 && dm[0].hooks === L.POOL_KEY.hooks &&
    dm[1] === mp.tickLower && dm[2] === mp.tickUpper && dm[3] === mp.liquidity && dm[4] === mp.amount0Max && dm[5] === mp.amount1Max && getAddress(dm[6]) === owner && dm[7] === mp.hookData);
  const dmod = await h('decModify', [L.encodeModifyLiquidityParams({ tokenId: 1795n, liquidity: 999n, amount0: 11n, amount1: 22n })]);
  check('DECREASE/INCREASE params decode (uint256,uint256,uint128,uint128,bytes)', dmod[0] === 1795n && dmod[1] === 999n && dmod[2] === 11n && dmod[3] === 22n && dmod[4] === '0x');
  const db = await h('decBurn', [L.encodeBurnParams({ tokenId: 42n, amount0Min: 3n, amount1Min: 4n })]);
  check('BURN_POSITION params decode (uint256,uint128,uint128,bytes)', db[0] === 42n && db[1] === 3n && db[2] === 4n && db[3] === '0x');
  const dp = await h('decPair', [L.encodeSettlePair()]);
  check('SETTLE_PAIR params decode (currency0,currency1)', dp[0] === L.POOL_KEY.currency0 && dp[1] === L.POOL_KEY.currency1);
  const dpa = await h('decPairAddr', [L.encodeTakePair(owner)]);
  check('TAKE_PAIR params decode (currency0,currency1,recipient)', dpa[0] === L.POOL_KEY.currency0 && dpa[1] === L.POOL_KEY.currency1 && getAddress(dpa[2]) === owner);

  // full builders: decode modifyLiquidities calldata through decodeActionsRouterParams
  const decodeBuilt = async (req) => {
    const data = req.args[0];
    const [actions, params] = await h('decRouter', [data]);
    return { actions: [...Buffer.from(actions.slice(2), 'hex')], params };
  };
  const plan = { tickLower: 282400, tickUpper: 293400, liquidity: 5n, amount0: 6n, amount1: 7n, amount0Max: 6n, amount1Max: 7n };
  const bm = await decodeBuilt(L.buildMint({ plan, owner, deadline: 9n }));
  const bmMint = await h('decMint', [bm.params[0]]);
  const bmSettle = await h('decPair', [bm.params[1]]);
  check('buildMint: actions [0x02,0x0d], MINT params + SETTLE_PAIR decode', JSON.stringify(bm.actions) === '[2,13]' && bmMint[1] === 282400 && bmMint[2] === 293400 && bmMint[3] === 5n && bmMint[4] === 6n && bmMint[5] === 7n && getAddress(bmMint[6]) === owner && bmSettle[0] === L.POOL_KEY.currency0);
  const bmRaw = L.buildMint({ plan, owner, deadline: 9n });
  check('buildMint deadline arg', bmRaw.args[1] === 9n && bmRaw.functionName === 'modifyLiquidities');
  const bc = await decodeBuilt(L.buildCollect({ tokenId: 7n, recipient: owner, deadline: 1n }));
  const bcDec = await h('decModify', [bc.params[0]]);
  const bcTake = await h('decPairAddr', [bc.params[1]]);
  check('buildCollect: actions [0x01,0x11], DECREASE(liquidity 0, mins 0) + TAKE_PAIR(user)', JSON.stringify(bc.actions) === '[1,17]' && bcDec[0] === 7n && bcDec[1] === 0n && bcDec[2] === 0n && bcDec[3] === 0n && getAddress(bcTake[2]) === owner);
  const bd = await decodeBuilt(L.buildDecrease({ tokenId: 8n, liquidity: 100n, amount0Min: 1n, amount1Min: 2n, recipient: owner, deadline: 1n, burn: true }));
  const bdDec = await h('decModify', [bd.params[0]]);
  const bdBurn = await h('decBurn', [bd.params[1]]);
  const bdTake = await h('decPairAddr', [bd.params[2]]);
  check('buildDecrease(burn): actions [0x01,0x03,0x11], mins in DECREASE, BURN(id,0,0)', JSON.stringify(bd.actions) === '[1,3,17]' && bdDec[0] === 8n && bdDec[1] === 100n && bdDec[2] === 1n && bdDec[3] === 2n && bdBurn[0] === 8n && getAddress(bdTake[2]) === owner);
  const bb = await decodeBuilt(L.buildBurnEmpty({ tokenId: 9n, recipient: owner, deadline: 1n }));
  const bbBurn = await h('decBurn', [bb.params[0]]);
  const bbTake = await h('decPairAddr', [bb.params[1]]);
  check('buildBurnEmpty: actions [0x03,0x11], BURN(id,0,0) + TAKE_PAIR(user)', JSON.stringify(bb.actions) === '[3,17]' && bbBurn[0] === 9n && bbBurn[1] === 0n && bbBurn[2] === 0n && bbTake[0] === L.POOL_KEY.currency0 && bbTake[1] === L.POOL_KEY.currency1 && getAddress(bbTake[2]) === owner);
  // tool fee: TAKE params are 3 words (Currency, address, uint256). The canonical decodeCurrencyPairAndAddress reads the
  // same 3 word offsets (0x00, 0x20, 0x40), so it decodes a TAKE as (currency, recipient, amount) for amount < 2^160.
  {
    const fees = { amount0: 1234567n, amount1: 98765432109876543n };
    const s = L.toolFeeSplit(fees);
    const fc = await decodeBuilt(L.buildCollect({ tokenId: 7n, recipient: owner, deadline: 1n, expectedFees: fees }));
    const [t0, t1, tp] = [await h('decPairAddr', [fc.params[1]]), await h('decPairAddr', [fc.params[2]]), await h('decPairAddr', [fc.params[3]])];
    check('buildCollect(fees): decodeActionsRouterParams -> [0x01,0x0e,0x0e,0x11]; TAKE(USDC, FEE_RECIPIENT, 10%), TAKE(KNTQ, FEE_RECIPIENT, 10%), TAKE_PAIR(user)',
      JSON.stringify(fc.actions) === '[1,14,14,17]' && t0[0] === L.ADDR.USDC && getAddress(t0[1]) === L.FEE_RECIPIENT && BigInt(t0[2]) === s.fee0 && s.fee0 === 123456n &&
      t1[0] === L.ADDR.KNTQ && getAddress(t1[1]) === L.FEE_RECIPIENT && BigInt(t1[2]) === s.fee1 && getAddress(tp[2]) === owner);
    const fd = await decodeBuilt(L.buildDecrease({ tokenId: 8n, liquidity: 100n, amount0Min: 1n, amount1Min: 2n, recipient: owner, deadline: 1n, burn: true, expected: { amount0: 5n, amount1: 6n, fees: { amount0: 0n, amount1: 777n } }, pool: 'HYPE' }));
    const fd0 = await h('decModify', [fd.params[0]]);
    const fdT = await h('decPairAddr', [fd.params[1]]);
    const fdP1 = await h('decPairAddr', [fd.params[2]]);
    const fdL = await h('decModify', [fd.params[3]]);
    const fdB = await h('decBurn', [fd.params[4]]);
    const fdP = await h('decPairAddr', [fd.params[5]]);
    check('HYPE buildDecrease(burn, fees only in KNTQ): [0x01,0x0e,0x11,0x01,0x03,0x11] = DECREASE(id,0,0,0), TAKE(KNTQ, FEE_RECIPIENT, 77), TAKE_PAIR(0x0,KNTQ,user), DECREASE(id,100,1,2), BURN(id), TAKE_PAIR(0x0,KNTQ,user)',
      JSON.stringify(fd.actions) === '[1,14,17,1,3,17]' && fd0[0] === 8n && fd0[1] === 0n && fd0[2] === 0n && fd0[3] === 0n &&
      fdT[0] === L.ADDR.KNTQ && getAddress(fdT[1]) === L.FEE_RECIPIENT && BigInt(fdT[2]) === 77n && fdP1[0] === L.ZERO_ADDRESS && getAddress(fdP1[2]) === owner &&
      fdL[0] === 8n && fdL[1] === 100n && fdL[2] === 1n && fdL[3] === 2n && fdB[0] === 8n && fdP[0] === L.ZERO_ADDRESS && getAddress(fdP[2]) === owner);
    const fz = await decodeBuilt(L.buildDecrease({ tokenId: 8n, liquidity: 100n, amount0Min: 1n, amount1Min: 2n, recipient: owner, deadline: 1n, burn: true, expected: { amount0: 5n, amount1: 6n, fees: { amount0: 9n, amount1: 0n } } }));
    check('buildDecrease with no fee share (fees < 10 wei): old shape [0x01,0x03,0x11], no DECREASE(0) segment', JSON.stringify(fz.actions) === '[1,3,17]' && (await h('decModify', [fz.params[0]]))[1] === 100n);
  }

  console.log('-- multi-pool: KNTQ/HYPE 0.8% (native) builders vs CalldataDecoder --');
  {
    const HP = L.LP_POOLS.HYPE;
    check('PoolIdLibrary.toId(HYPE LP key) == 0xd210…3472 == SWAP_POOLS.KNTQ.id', (await h('poolId', [keyTuple(HP.key)])) === HP.poolId && HP.poolId === L.SWAP_POOLS.KNTQ.id);
    const hplan = { pool: 'HYPE', tickLower: -887160, tickUpper: 887160, liquidity: 11n, amount0: 6n, amount1: 7n, amount0Max: 66n, amount1Max: 77n };
    const hm = L.buildMint({ plan: hplan, owner, deadline: 9n });
    const hd = await decodeBuilt(hm);
    const hMint = await h('decMint', [hd.params[0]]);
    const hSettle = await h('decPair', [hd.params[1]]);
    const hSweep = await h('decPair', [hd.params[2]]); // SWEEP params (Currency, address) share decodeCurrencyPair's 2-word layout
    check('HYPE buildMint: actions [0x02,0x0d,0x14]; MINT key = HYPE pool key, ticks ±887160, maxes',
      JSON.stringify(hd.actions) === '[2,13,20]' && hMint[0].currency0 === L.ZERO_ADDRESS && hMint[0].currency1 === L.ADDR.KNTQ && hMint[0].fee === 8000 && hMint[0].tickSpacing === 120 &&
      hMint[1] === -887160 && hMint[2] === 887160 && hMint[3] === 11n && hMint[4] === 66n && hMint[5] === 77n && getAddress(hMint[6]) === owner);
    check('HYPE buildMint: SETTLE_PAIR(0x0, KNTQ), SWEEP(0x0, owner), tx value == amount0Max', hSettle[0] === L.ZERO_ADDRESS && hSettle[1] === L.ADDR.KNTQ && hSweep[0] === L.ZERO_ADDRESS && getAddress(hSweep[1]) === owner && hm.tx.value === 66n);
    const hc = await decodeBuilt(L.buildCollect({ tokenId: 7n, recipient: owner, deadline: 1n, pool: 'HYPE' }));
    const hcTake = await h('decPairAddr', [hc.params[1]]);
    check('HYPE buildCollect: TAKE_PAIR(0x0 native, KNTQ, user)', JSON.stringify(hc.actions) === '[1,17]' && hcTake[0] === L.ZERO_ADDRESS && hcTake[1] === L.ADDR.KNTQ && getAddress(hcTake[2]) === owner);
    const hdc = await decodeBuilt(L.buildDecrease({ tokenId: 8n, liquidity: 5n, amount0Min: 1n, amount1Min: 2n, recipient: owner, deadline: 1n, burn: true, pool: 'HYPE' }));
    const hdTake = await h('decPairAddr', [hdc.params[2]]);
    check('HYPE buildDecrease(burn): [0x01,0x03,0x11], TAKE_PAIR(0x0, KNTQ, user)', JSON.stringify(hdc.actions) === '[1,3,17]' && hdTake[0] === L.ZERO_ADDRESS && hdTake[1] === L.ADDR.KNTQ);
    const hb = await decodeBuilt(L.buildBurnEmpty({ tokenId: 9n, recipient: owner, deadline: 1n, pool: 'HYPE' }));
    const hbTake = await h('decPairAddr', [hb.params[1]]);
    check('HYPE buildBurnEmpty: TAKE_PAIR(0x0, KNTQ, user)', JSON.stringify(hb.actions) === '[3,17]' && hbTake[0] === L.ZERO_ADDRESS && hbTake[1] === L.ADDR.KNTQ);
    let hpi = true;
    for (const [tl, tu] of [[-887160, 887160], [49200, 60240], [-240, -120], [-120, 0]]) {
      const d = L.decodePositionInfo(await h('infoOf', [keyTuple(HP.key), tl, tu]));
      if (d.tickLower !== tl || d.tickUpper !== tu || d.poolId !== HP.poolId.slice(0, 52)) hpi = false;
    }
    check('HYPE pool positionInfo roundtrip (spacing-120 ticks, poolId prefix)', hpi);
    const hs = await L.readPoolState(pub, undefined, HP.poolId);
    const hs0 = await h('slot0', [L.ADDR.POOL_MANAGER, HP.poolId]);
    check('HYPE pool readPoolState slot0/liquidity == StateLibrary', hs0[0] === hs.sqrtPriceX96 && hs0[1] === hs.tick && hs0[3] === 8000 && (await h('liquidity', [L.ADDR.POOL_MANAGER, HP.poolId])) === hs.liquidity, `tick ${hs.tick}`);
    const htvl = await L.readPoolTvl(pub, hs, 'HYPE');
    let hti = htvl.ticks.length > 0;
    let hsum = 0n, hact = 0n;
    for (const t of htvl.ticks) {
      const ti = await h('tickInfo', [L.ADDR.POOL_MANAGER, HP.poolId, t.tick]);
      if (ti[1] !== t.liquidityNet || t.tick % 120 !== 0) hti = false;
      hsum += t.liquidityNet;
      if (t.tick <= hs.tick) hact += t.liquidityNet;
    }
    check(`HYPE pool readPoolTvl: ${htvl.ticks.length} ticks (spacing 120) match getTickInfo; net sums 0; active == liquidity`, hti && hsum === 0n && hact === hs.liquidity);
  }

  console.log('-- StateLibrary reads vs lib extsload slot math --');
  const PM = L.ADDR.POOL_MANAGER, ID = L.TARGET_POOL_ID;
  let state = await L.readPoolState(pub);
  const s0 = await h('slot0', [PM, ID]);
  check('readPoolState slot0 == StateLibrary.getSlot0', s0[0] === state.sqrtPriceX96 && s0[1] === state.tick && s0[2] === state.protocolFee && s0[3] === state.lpFee, `tick ${state.tick}`);
  check('readPoolState liquidity == StateLibrary.getLiquidity', (await h('liquidity', [PM, ID])) === state.liquidity, `${state.liquidity}`);
  const fg = await h('fgg', [PM, ID]);
  check('feeGrowthGlobals == StateLibrary.getFeeGrowthGlobals', fg[0] === state.feeGrowthGlobal0X128 && fg[1] === state.feeGrowthGlobal1X128);
  const tvl = await L.readPoolTvl(pub, state);
  let tiOk = tvl.ticks.length > 0;
  for (const t of tvl.ticks) {
    const ti = await h('tickInfo', [PM, ID, t.tick]);
    if (ti[1] !== t.liquidityNet || ti[0] === 0n) { tiOk = false; log('tickInfo mismatch', t, ti); }
    const compressed = Math.floor(t.tick / 200);
    const word = await h('bitmap', [PM, ID, compressed >> 8]);
    if (((word >> BigInt(compressed & 0xff)) & 1n) !== 1n) tiOk = false;
  }
  check(`readPoolTvl: ${tvl.ticks.length} initialized ticks match StateLibrary.getTickInfo/getTickBitmap`, tiOk);
  let netSum = 0n; for (const t of tvl.ticks) netSum += t.liquidityNet;
  check('sum(liquidityNet) over all initialized ticks == 0', netSum === 0n);
  let active = 0n; for (const t of tvl.ticks) if (t.tick <= state.tick) active += t.liquidityNet;
  check('sum(liquidityNet for tick <= current) == active liquidity', active === state.liquidity, `${active} vs ${state.liquidity}`);

  console.log('-- exact on-chain mint/decrease with ZERO slippage slack --');
  await fund(pub, test, L.ADDR.USDC, USER, 400_000000n);
  await fund(pub, test, L.ADDR.KNTQ, USER, 4000n * 10n ** 18n);
  const send = async (req) => {
    const { request } = await pub.simulateContract({ ...req, account: USER, chain });
    const hash = await wallet.writeContract(request);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('reverted');
    return r;
  };
  const reverts = async (req, errName) => {
    try { await pub.simulateContract({ ...req, account: USER, chain }); return false; } catch (e) {
      const s = (e.shortMessage || '') + ' ' + (e.message || '') + ' ' + (e.cause?.data?.errorName || '');
      return errName ? s.includes(errName) : true;
    }
  };
  const bal = (t) => pub.readContract({ address: t, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [USER] });
  const nowSec = async () => Number((await pub.getBlock()).timestamp);

  state = await L.readPoolState(pub);
  const cur = state.tick;
  const alignedBelow = L.floorTick(cur);
  const scenarios = [
    { name: 'full, anchor USDC', r: L.rangeForPreset('full', cur), inp: { amount0: 13_370000n, anchor: 'amount0' } },
    { name: '±20%, anchor KNTQ', r: L.rangeForPreset('pm20', cur), inp: { amount1: 31n * 10n ** 18n + 123456789n, anchor: 'amount1' } },
    { name: '±50%, both amounts (no anchor)', r: L.rangeForPreset('pm50', cur), inp: { amount0: 7_000001n, amount1: 19n * 10n ** 18n } },
    { name: '±80%, anchor USDC', r: L.rangeForPreset('pm80', cur), inp: { amount0: 3_333333n, anchor: 'amount0' } },
    { name: 'one-spacing range containing tick', r: { tickLower: alignedBelow, tickUpper: alignedBelow + 200 }, inp: { amount0: 1_000000n, anchor: 'amount0' } },
    { name: 'above-price range (USDC only)', r: { tickLower: alignedBelow + 400, tickUpper: alignedBelow + 4000 }, inp: { amount0: 5_000000n, anchor: 'amount0' } },
    { name: 'below-price range (KNTQ only)', r: { tickLower: alignedBelow - 4000, tickUpper: alignedBelow }, inp: { amount1: 9n * 10n ** 18n, anchor: 'amount1' } },
  ];
  for (const sc of scenarios) {
    state = await L.readPoolState(pub);
    const p = L.planMint(state, sc.r.tickLower, sc.r.tickUpper, sc.inp, 0);
    if (p.liquidity === 0n) { check(`${sc.name}: plan liquidity > 0`, false); continue; }
    const deadline = L.deadlineFromNow(600, await nowSec());
    // tightness: amountMax = owed - 1 on a non-zero side must revert MaximumAmountExceeded
    const txs = await L.planMintTxs(pub, USER, p, { nowSec: await nowSec() });
    for (const tx of txs.filter((t) => t.kind !== 'mint')) await send(tx);
    if (p.amount0 > 0n) check(`${sc.name}: amount0Max = owed0-1 reverts`, await reverts(L.buildMint({ plan: { ...p, amount0Max: p.amount0 - 1n }, owner: USER, deadline }), 'MaximumAmountExceeded'));
    if (p.amount1 > 0n) check(`${sc.name}: amount1Max = owed1-1 reverts`, await reverts(L.buildMint({ plan: { ...p, amount1Max: p.amount1 - 1n }, owner: USER, deadline }), 'MaximumAmountExceeded'));
    const b0 = await bal(L.ADDR.USDC), b1 = await bal(L.ADDR.KNTQ);
    const rc = await send(L.buildMint({ plan: p, owner: USER, deadline }));
    const id = L.parseMintedTokenId(rc, USER);
    const d0 = b0 - (await bal(L.ADDR.USDC)), d1 = b1 - (await bal(L.ADDR.KNTQ));
    check(`${sc.name}: mint with 0 bps slack succeeds, pulled == plan exactly`, d0 === p.amount0 && d1 === p.amount1 && p.amount0Max === p.amount0 && p.amount1Max === p.amount1, `[${p.tickLower},${p.tickUpper}] ${d0}/${p.amount0} ${d1}/${p.amount1}`);
    if (sc.inp.anchor === 'amount0') check(`${sc.name}: owed0 within 1 wei of input`, p.amount0 <= sc.inp.amount0 + 1n && p.amount0 >= sc.inp.amount0 - 1n, `${p.amount0} vs ${sc.inp.amount0}`);
    // KNTQ (18 dec): one liquidity unit is worth ~1e5 wei, so owed1 may be below the input by < 1 L-unit; never above by > 1 wei
    if (sc.inp.anchor === 'amount1') check(`${sc.name}: owed1 <= input+1 and within 1e-9 relative`, p.amount1 <= sc.inp.amount1 + 1n && (sc.inp.amount1 - p.amount1) * 1_000_000_000n <= sc.inp.amount1, `${p.amount1} vs ${sc.inp.amount1}`);
    // position read vs StateLibrary
    state = await L.readPoolState(pub);
    const pos = await L.readPosition(pub, id, state);
    const pi = await h('posInfo', [PM, ID, L.ADDR.POSITION_MANAGER, p.tickLower, p.tickUpper, L.tokenIdSalt(id)]);
    const fgi = await h('fgInside', [PM, ID, p.tickLower, p.tickUpper]);
    const solFees0 = L.mulDiv((fgi[0] - pi[1] + (1n << 256n)) % (1n << 256n), pi[0], L.Q128);
    check(`${sc.name}: readPosition liquidity/fees == StateLibrary.getPositionInfo/getFeeGrowthInside`, pos.liquidity === pi[0] && pos.liquidity === p.liquidity && pos.fees.amount0 === solFees0, `L ${pos.liquidity}`);
    // decrease 37% with exact mins: mins = expected must pass, expected+1 must revert
    const part = (pos.liquidity * 37n) / 100n;
    const dd = L.planDecrease(state, pos, part, 0);
    const dl = L.deadlineFromNow(600, await nowSec());
    const mk = (m0, m1) => L.buildDecrease({ tokenId: id, liquidity: part, amount0Min: m0, amount1Min: m1, recipient: USER, deadline: dl });
    if (dd.expected.amount0 > 0n) check(`${sc.name}: decrease min0 = expected0+1 reverts`, await reverts(mk(dd.expected.amount0 + 1n, dd.amount1Min), 'MinimumAmountInsufficient'));
    if (dd.expected.amount1 > 0n) check(`${sc.name}: decrease min1 = expected1+1 reverts`, await reverts(mk(dd.amount0Min, dd.expected.amount1 + 1n), 'MinimumAmountInsufficient'));
    const c0 = await bal(L.ADDR.USDC), c1 = await bal(L.ADDR.KNTQ);
    await send(mk(dd.amount0Min, dd.amount1Min));
    const r0 = (await bal(L.ADDR.USDC)) - c0, r1 = (await bal(L.ADDR.KNTQ)) - c1;
    check(`${sc.name}: decrease 37% at 0 bps: received == expected exactly`, r0 === dd.expected.amount0 + pos.fees.amount0 && r1 === dd.expected.amount1 + pos.fees.amount1 && dd.amount0Min === dd.expected.amount0, `${r0}/${dd.expected.amount0} ${r1}/${dd.expected.amount1}`);
    // remove rest + burn
    const pos2 = await L.readPosition(pub, id, await L.readPoolState(pub));
    const d2 = L.planDecrease(await L.readPoolState(pub), pos2, pos2.liquidity, 0);
    await send(L.buildDecrease({ tokenId: id, liquidity: pos2.liquidity, amount0Min: d2.amount0Min, amount1Min: d2.amount1Min, recipient: USER, deadline: L.deadlineFromNow(600, await nowSec()), burn: true }));
    const gone = await pub.readContract({ address: L.ADDR.POSITION_MANAGER, abi: L.POSM_ABI, functionName: 'ownerOf', args: [id] }).then(() => false, () => true);
    check(`${sc.name}: remaining removed at 0 bps + burned`, gone);
  }

  // Permit2 allowance read roundtrip through lib.readAllowances
  const exp = (await nowSec()) + 1234;
  await send(L.buildPermit2Approve(L.ADDR.KNTQ, 123456n, exp));
  const ra = await L.readAllowances(pub, USER, L.ADDR.KNTQ);
  check('buildPermit2Approve -> readAllowances roundtrip (amount, expiration)', ra.p2.amount === 123456n && ra.p2.expiration === exp, JSON.stringify({ a: ra.p2.amount.toString(), e: ra.p2.expiration }));
}

async function fund(pub, test, token, to, amount) {
  const latest = await pub.getBlockNumber();
  const candidates = new Set();
  for (let end = latest, i = 0; i < 20 && candidates.size < 40; i++, end -= 5000n) {
    try {
      const logs = await pub.request({ method: 'eth_getLogs', params: [{ address: token, fromBlock: toHex(end - 4999n), toBlock: toHex(end), topics: [L.TRANSFER_TOPIC] }] });
      for (const l of logs.slice(-200)) candidates.add(getAddress('0x' + l.topics[2].slice(26)));
    } catch {}
  }
  let best = null, bestBal = 0n;
  for (const c of candidates) {
    if (c === L.ADDR.POOL_MANAGER || c === L.ADDR.POSITION_MANAGER) continue;
    const b = await pub.readContract({ address: token, abi: L.ERC20_ABI, functionName: 'balanceOf', args: [c] });
    if (b > bestBal) { best = c; bestBal = b; }
  }
  if (!best || bestBal < amount) best = L.ADDR.POOL_MANAGER;
  await test.impersonateAccount({ address: best });
  await test.setBalance({ address: best, value: 10n ** 20n });
  const w = createWalletClient({ chain: pub.chain, transport: http(FORK_RPC), account: best });
  const hash = await w.writeContract({ address: token, abi: L.ERC20_ABI, functionName: 'transfer', args: [to, amount], chain: pub.chain });
  await pub.waitForTransactionReceipt({ hash });
  await test.stopImpersonatingAccount({ address: best });
  await test.setBalance({ address: to, value: 10n ** 21n });
}

async function main() {
  console.log('== lp-helper encoding/math verification ==');
  await staticChecks();
  if (!(await rpcReachable(L.RPC_URL))) {
    console.log('SKIP chain checks: RPC unreachable');
  } else {
    const anvil = await startAnvil();
    try { await run(); } finally { try { anvil.kill(); } catch {} }
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed}/${results.length} checks passed`);
  return failed === 0 ? 0 : 1;
}
main().then((c) => process.exit(c), (e) => { console.error('FAIL: crashed', e); process.exit(1); });
