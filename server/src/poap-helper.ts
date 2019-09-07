import { Contract, ContractTransaction } from 'ethers';
import { verifyMessage, toUtf8Bytes, keccak256 } from 'ethers/utils';
import { readFileSync } from 'fs';
import { join } from 'path';
import pino from 'pino';
import { getEvent, getEvents, getPoapSettingByName, saveTransaction } from './db';
import getEnv from './envs';
import { Poap } from './poap-eth/Poap';
import { VotePoap } from './poap-eth/VotePoap';
import { Address, Claim, TokenInfo, Vote } from './types';

const Logger = pino();
const ABI_DIR = join(__dirname, '../abi');

export function getABI(name: string) {
  return JSON.parse(readFileSync(join(ABI_DIR, `${name}.json`)).toString());
}

const ABI = getABI('Poap');
const voteABI = getABI('VotePoap');

export function getContract(): Poap {
  const env = getEnv();
  return new Contract(env.poapAddress, ABI, env.poapAdmin) as Poap;
}

export function getVoteContract(): VotePoap {
  const env = getEnv();
  return new Contract(env.poapVoteAddress, voteABI, env.poapAdmin) as VotePoap;
}

/**
 * Estimate gas cost for mintTokenBatch() call.
 * We don't rely on estimateGas() since it fails.
 *
 * The estimated is based on empirical tests and it's
 * also +50% of the actual empirical estimate
 * @param n number of addresses
 */
export function estimateMintingGas(n: number) {
  const delta = 136907;
  const baseCost = 35708;
  return (baseCost + n * delta) * 1.5;
}

/**
 * Get current gas price from Poap Settings singleton
 */
export async function getCurrentGasPrice() {
  // Default gas price (to be used only when no gas-price configuration detected)
  let gasPrice = 5e9;

  // Get gas-price value from db Poap Setting variable
  let gasPriceSetting = await getPoapSettingByName('gas-price');
  if (gasPriceSetting) {
    gasPrice = parseInt(gasPriceSetting.value);
  }

  return gasPrice;
}

export async function mintToken(eventId: number, toAddr: Address) {
  const contract = getContract();

  // Set a new Value, which returns the transaction
  const tx = await contract.functions.mintToken(eventId, toAddr, {
    gasLimit: estimateMintingGas(1),
    gasPrice: await getCurrentGasPrice(),
  });

  if(tx.hash){
    await saveTransaction(tx.hash, tx.nonce, 'mintToken', JSON.stringify([eventId, toAddr]));
  }

  console.log(`mintToken: Transaction: ${tx.hash}`);

  // The operation is NOT complete yet; we must wait until it is mined
  await tx.wait();
  console.log(`mintToken: Finished: ${tx.hash}`);
}

export async function mintEventToManyUsers(eventId: number, toAddr: Address[]) {
  const contract = getContract();

  // Set a new Value, which returns the transaction
  const tx = await contract.functions.mintEventToManyUsers(eventId, toAddr, {
    gasLimit: estimateMintingGas(toAddr.length),
    gasPrice: await getCurrentGasPrice(),
  });

  if(tx.hash){
    await saveTransaction(tx.hash, tx.nonce, 'mintEventToManyUsers', JSON.stringify([eventId, toAddr]));
  }

  console.log(`mintTokenBatch: Transaction: ${tx.hash}`);

  // The operation is NOT complete yet; we must wait until it is mined
  await tx.wait();
  console.log(`mintTokenBatch: Finished ${tx.hash}`);
}

export async function mintUserToManyEvents(eventIds: number[], toAddr: Address) {
  const contract = getContract();

  // Set a new Value, which returns the transaction
  const tx = await contract.functions.mintUserToManyEvents(eventIds, toAddr, {
    gasLimit: estimateMintingGas(eventIds.length),
    gasPrice: await getCurrentGasPrice(),
  });

  if(tx.hash){
    await saveTransaction(tx.hash, tx.nonce, 'mintUserToManyEvents', JSON.stringify({eventIds, toAddr}));
  }

  console.log(`mintTokenBatch: Transaction: ${tx.hash}`);

  // The operation is NOT complete yet; we must wait until it is mined
  await tx.wait();
  console.log(`mintTokenBatch: Finished ${tx.hash}`);
}

export async function burnToken(tokenId: string | number): Promise<boolean> {
  const contract = getContract();

  // Set a new Value, which returns the transaction
  const tx = await contract.functions.burn(tokenId, {
    gasLimit: estimateMintingGas(1),
    gasPrice: await getCurrentGasPrice(),
  });

  if(tx.hash){
    await saveTransaction(tx.hash, tx.nonce, 'burnToken', tokenId.toString());
  }

  console.log(`burn: Transaction: ${tx.hash}`);

  // The operation is NOT complete yet; we must wait until it is mined
  await tx.wait();
  console.log(`burn: Finished ${tx.hash}`);
  return true
}

export async function getAllTokens(address: Address): Promise<TokenInfo[]> {
  const events = await getEvents();

  const getEvent = (id: number) => {
    const ev = events.find(e => e.id === id);
    if (!ev) {
      throw new Error(`Invalid EventId: ${id}`);
    }
    return ev;
  };

  const contract = getContract();
  const tokensAmount = (await contract.functions.balanceOf(address)).toNumber();

  const tokens: TokenInfo[] = [];
  for (let i = 0; i < tokensAmount; i++) {
    const { tokenId, eventId } = await contract.functions.tokenDetailsOfOwnerByIndex(address, i);
    tokens.push({
      event: getEvent(eventId.toNumber()),
      tokenId: tokenId.toString(),
      owner: address,
    });
  }
  return tokens;
}

export async function getTokenInfo(tokenId: string | number): Promise<TokenInfo> {
  const contract = getContract();
  const eventId = await contract.functions.tokenEvent(tokenId);
  const owner = await contract.functions.ownerOf(tokenId);
  const event = await getEvent(eventId.toNumber());
  if (!event) {
    throw new Error('Invalid Event Id');
  }
  return {
    event,
    tokenId: tokenId.toString(),
    owner,
  };
}

export async function verifyClaim(claim: Claim): Promise<string|boolean> {
  const event = await getEvent(claim.eventId);

  if (!event) {
    throw new Error('Invalid Event Id');
  }

  Logger.info({ claim }, 'Claim for event: %d from: %s', claim.eventId, claim.claimer);

  const claimerMessage = JSON.stringify([claim.claimId, claim.eventId, claim.claimer, claim.proof]);

  Logger.info({ claimerMessage }, 'claimerMessage');

  const supposedClaimedAddress = verifyMessage(claimerMessage, claim.claimerSignature);

  if (supposedClaimedAddress !== claim.claimer) {
    console.log('invalid claimer signature');
    return false;
  }

  const proofMessage = JSON.stringify([claim.claimId, claim.eventId, claim.claimer]);
  Logger.info({ proofMessage }, 'proofMessage');
  const signerAddress = verifyMessage(proofMessage, claim.proof);

  if (signerAddress !== event.signer) {
    console.log('invalid signer signature');
    return false;
  }

  return true;
}

export async function relayedVoteCall(vote: Vote): Promise<boolean|ContractTransaction> {
  const contract = getVoteContract();
  // const claimerMessage = JSON.stringify([vote.proposal,]);
  const claimerMessage = vote.proposal.toString();
  let messageBytes = toUtf8Bytes(claimerMessage);
  const supposedClaimedAddress = verifyMessage(keccak256(messageBytes), vote.claimerSignature);
  const isValid = supposedClaimedAddress === vote.claimer;

  if(isValid){
    try {
      // @ts-ignore
      const { claimer, proposal } = vote;
      const tx = await contract.functions.relayedVote(claimer, proposal, {
        gasLimit: 450000000
      });

      if(tx.hash){
        await saveTransaction(tx.hash, tx.nonce, 'relayedVote', JSON.stringify([claimer, proposal]));
      }
      return tx;
    } catch (e) {
      console.log('Error: ', e);
    }
  }
  return false;
}
