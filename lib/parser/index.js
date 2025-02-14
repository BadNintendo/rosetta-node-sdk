/**
 * @license
 * Copyright (c) 2020 DigiByte Foundation NZ Limited
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/**
 * @module Parser
 */

const Logger = require('../logger');
const RosettaClient = require('rosetta-node-sdk-client');
const { ParserError } = require('../errors');

const {
  AddValues,
  Hash,
  AmountValue,
  NegateValue,
} = require('../utils');

const { Sign } = require('../models');

const ExpectedOppositesLength = 2;

const EMPTY_OPERATIONS_GROUP = {
  type: '',
  operations: [],
  currencies: [],
  nil_amount_present: false,
};

class Match {
  /**
   * Constructs a Match object that holds operations and their corresponding amounts.
   * @constructor
   * @param {Rosetta:Operation[]} operations - Array of operations.
   * @param {number[]} amounts - Corresponding amounts to the operations, can be null if not available.
   */
  constructor({operations = [], amounts = []} = {}) {
    this.operations = operations;
    this.amounts = amounts;
  }

  /**
   * Returns the first operation and its corresponding amount if available.
   * @returns {{operation: Rosetta:Operation|null, amount: number|null}} The first operation and amount.
   */
  first() {
    return this.operations.length > 0 ? { operation: this.operations[0], amount: this.amounts[0] } : { operation: null, amount: null };
  }
}

class RosettaParser {
  /**
   * Initializes a new instance of RosettaParser.
   * @constructor
   * @param {RosettaAsserter} asserter - An asserter to validate operation success.
   * @param {ExemptOperation} exemptFunc - A function to determine if an operation should be exempt from processing.
   */
  constructor({asserter, exemptFunc} = {}) {
    this.asserter = asserter;
    this.exemptFunc = exemptFunc;
  }

  /**
   * Determines whether an operation should be skipped based on various checks.
   * @param {Rosetta:Operation} operation - The operation to be checked.
   * @returns {boolean} True if the operation should be skipped, false otherwise.
   */
  skipOperation(operation) {
    const isOperationSuccessful = this.asserter.OperationSuccessful(operation);
    if (!isOperationSuccessful) {
      Logger.verbose(`Skipping operation as it was not successful: ${JSON.stringify(operation)}`);
      return true;
    }

    if (!operation.account || !operation.amount) {
      Logger.verbose(`Skipping operation due to missing ${!operation.account ? 'account' : 'amount'}: ${JSON.stringify(operation)}`);
      return true;
    }

    if (this.exemptFunc && this.exemptFunc(operation)) {
      Logger.verbose(`Skipping exempt operation: ${JSON.stringify(operation)}`);
      return true;
    }

    return false;
  }

  /**
   * Calculates and returns all balance changes for a given block, considering if the block was removed.
   * @param {Rosetta:Block} block - The block containing transactions to be processed.
   * @param {boolean} blockRemoved - Indicates whether the block is considered removed (orphaned).
   * @returns {BalanceChange[]} An array of all balance changes calculated.
   */
  balanceChanges(block, blockRemoved) {
    const balanceChangesMap = new Map();

    for (let tx of block.transactions) {
      for (let op of tx.operations) {
        if (this.skipOperation(op)) continue;

        const { account, amount } = op;
        const adjustedValue = blockRemoved ? NegateValue(amount.value) : amount.value;
        const blockIdentifier = blockRemoved ? block.parent_block_identifier : block.block_identifier;
        const key = `${Hash(account)}/${Hash(amount.currency)}`;

        if (!balanceChangesMap.has(key)) {
          balanceChangesMap.set(key, {
            account_identifier: account,
            currency: amount.currency,
            block_identifier: blockIdentifier,
            difference: adjustedValue
          });
        } else {
          const change = balanceChangesMap.get(key);
          change.difference = AddValues(change.difference, adjustedValue);
        }
      }
    }

    return Array.from(balanceChangesMap.values());
  }

  /**
   * Adds an operation to an operation group and updates tracking arrays.
   * @param {OperationGroup} operationsGroup - The group to add the operation to.
   * @param {number} destinationIndex - The index in the group where the operation is to be added.
   * @param {number[]} assignmentsArray - Array tracking assignment indices.
   * @param {Rosetta:Operation} operation - The operation to add.
   */
  addOperationToGroup(operationsGroup = EMPTY_OPERATIONS_GROUP, destinationIndex, assignmentsArray = [], operation) {
    if (operation.type !== operationsGroup.type && operationsGroup.type !== '') {
      operationsGroup.type = '';
    }

    operationsGroup.operations.push(operation);
    assignmentsArray[operation.operation_identifier.index] = destinationIndex;

    if (!operation.amount) {
      operationsGroup.nil_amount_present = true;
      return;
    }

    operationsGroup.nil_amount_present = false;

    if (-1 === operationsGroup.currencies.findIndex(curr => Hash(curr) === Hash(operation.amount.currency))) {
      operationsGroup.currencies.push(operation.amount.currency);
    }
  }

  /**
   * Sorts groups of operations and returns them as an array.
   * @param {number} operationsCount - Total number of operations to sort.
   * @param {Object<string, OperationGroup>} operationsGroup - Groups to sort.
   * @returns {OperationGroup[]} Sorted operation groups.
   */
  sortOperationsGroup(operationsCount, operationsGroup) {
    const sliceGroups = [];

    for (let i = 0; i < operationsCount; ++i) {
      const v = operationsGroup[i];

      if (v == null) {
        continue;
      }

      v.operations.sort((a, b) => a.operation_identifier.index - b.operation_identifier.index);
      sliceGroups.push(v);
    }

    return sliceGroups;
  }

  /**
   * Groups operations based on their relationships and types.
   * @param {Rosetta:Transaction} transaction - The transaction containing operations to group.
   * @returns {OperationGroup[]} An array of operation groups derived from the transaction.
   */
  groupOperations(transaction) {
    const ops = transaction.operations || [];
    const opGroups = {};
    const opAssignments = new Array(ops.length).fill(0);
    let counter = 0;

    for (let i = 0; i < ops.length; ++i) {
      const op = ops[i];
      if (!op.related_operations || op.related_operations.length === 0) {
        let key = counter++;
        opGroups[key] = {
          type: op.type,
          operations: [RosettaClient.Operation.constructFromObject(op)],
          currencies: op.amount ? [op.amount.currency] : [],
          nil_amount_present: op.amount == null
        };
        opAssignments[i] = key;
        continue;
      }

      const groupsToMerge = [];
      for (let relatedOp of op.related_operations) {
        if (!groupsToMerge.includes(opAssignments[relatedOp.index])) {
          groupsToMerge.push(opAssignments[relatedOp.index]);
        }
      }

      groupsToMerge.sort();
      const mergedGroupIndex = groupsToMerge[0];
      const mergedGroup = opGroups[mergedGroupIndex];
      this.addOperationToGroup(mergedGroup, mergedGroupIndex, opAssignments, op);

      for (let otherGroupIndex of groupsToMerge.slice(1)) {
        const otherGroup = opGroups[otherGroupIndex];
        for (let otherOp of otherGroup.operations) {
          this.addOperationToGroup(mergedGroup, mergedGroupIndex, opAssignments, otherOp);
        }
        delete opGroups[otherGroupIndex];
      }
    }

    return this.sortOperationsGroup(ops.length, opGroups);
  }

  /**
   * Derives Operations from a transaction.
   * Must not be called, unless properly validated (asserted for correctness).
   *
   * @param {Rosetta:Transaction} transaction - input transaction.
   * @return {OperationGroup[]} - operations group array.
   */
  groupOperations(transaction) {
    const ops = transaction.operations || [];

    const opGroups = {};
    const opAssignments = new Array(ops.length).fill(0);
    let counter = 0;

    if (ops) {
      for (let i = 0; i < ops.length; ++i) {
        const op = ops[i];

        // Create a new group
        if (!op.related_operations || op.related_operations.length === 0) {
          let key = counter++;

          opGroups[key] = {
            type: op.type,
            operations: [
              RosettaClient.Operation.constructFromObject(op),
            ],
          };

          if (op.amount != null) {
            opGroups[key].currencies = [op.amount.currency];
            opGroups[key].nil_amount_present = false;
          } else {
            opGroups[key].currencies = [];
            opGroups[key].nil_amount_present = true;
          }

          opAssignments[i] = key;
          continue;
        }

        // Find groups to merge
        const groupsToMerge = [];
        for (let relatedOp of (op.related_operations || [])) {
          if (!groupsToMerge.includes(opAssignments[relatedOp.index])) {
            groupsToMerge.push(opAssignments[relatedOp.index]);
          }
        }

        // Ensure that they are sorted, so we can merge other groups.
        groupsToMerge.sort();

        const mergedGroupIndex = groupsToMerge[0];
        const mergedGroup = opGroups[mergedGroupIndex];

        this.addOperationToGroup(mergedGroup, mergedGroupIndex, opAssignments, op);

        for (let otherGroupIndex of groupsToMerge.slice(1)) {
          const otherGroup = opGroups[otherGroupIndex];

          // Add otherGroup ops to mergedGroup
          for (let otherOp of otherGroup.operations) {
            this.addOperationToGroup(mergedGroup, mergedGroupIndex, opAssignments, otherOp);
          }

          delete opGroups[otherGroupIndex];
        }
      }

      return this.sortOperationsGroup(ops.length, opGroups);
    }

    return this.sortOperationsGroup(0, opGroups);
  }

  /**
   * Match is coin action the same as expected.
   *
   * @param {Rosetta:CoinAction} requiredCoinAction - coin action.
   * @param {Rosetta:CoinChange} coinChange - coin change.
   * @return {null} - not valid requiredCoinAction.
   * @throws {ParserError} thrown if the provided coinChange is null or not valid coinChange.coin_action.
   */
  coinActionMatch(requiredCoinAction, coinChange) {
    if (!requiredCoinAction || typeof requiredCoinAction !== 'string') {
      return null;
    }

    if (coinChange == null) {
      throw new ParserError(`coin change is null but expected ${requiredCoinAction}`);
    }

    if (coinChange.coin_action !== requiredCoinAction) {
      throw new ParserError(`coin change_action is ${coinChange.coin_action} ` +
        `but expected ${requiredCoinAction}`);
    }
  }

  /**
   * metadataMatch returns an error if a string[] does not meet
   * a slice of *MetadataDescription.
   *
   * @param {MetadataDescription[]} metadataDescriptionArray - array for check.
   * @param {Object<string,any>} metadataMap - metadata.
   * @throws {ParserError} thrown if key not present in metadata or key value is not of expected type.
   */
  metadataMatch(metadataDescriptionArray, metadataMap) {
    if (metadataDescriptionArray.length === 0) {
      return;
    }

    for (let req of metadataDescriptionArray) {
      const val = metadataMap[req.key];

      if (!val) {
        throw new ParserError(`${req.key} not present in metadata`);
      }

      if (typeof val != req.value_kind) {
        throw new ParserError(`${req.key} value is not of type ${req.value_kind}`);
      }
    }
  }

  /**
   * accountMatch returns an error if a *types.AccountIdentifier does not meet an *AccountDescription.
   *
   * @param {AccountDescription} accountDescription - describe a AccountIdentifier.
   * @param {Rosetta:AccountIdentifier} accountIdentifier - uniquely identifies an account within a network.
   * @throws {ParserError} thrown if account or sub_account_identifier is missing or some data from accountIdentifier mismatch accountDescription.
   */
  accountMatch(accountDescription, accountIdentifier) {
    if (accountDescription == null) {
      return;
    }

    if (accountIdentifier == null) {
      if (accountDescription.exists) {
        throw new ParserError(`Account is missing`);
      }
      return;
    }

    if (accountIdentifier.sub_account == null) {
      if (accountDescription.sub_account_exists) {
        throw new ParserError(`sub_account_identifier is missing`);
      }
      return;
    }

    if (!accountDescription.sub_account_exists) {
      throw new ParserError(`sub_account is populated`);
    }

    if (accountDescription.sub_account_address.length > 0 &&
      accountIdentifier.sub_account.address !== accountDescription.sub_account_address) {
      throw new ParserError(`sub_account_identifier.address is ${accountIdentifier.sub_account.address} not ${accountDescription.sub_account_address}`);
    }

    try {
      this.metadataMatch(accountDescription.sub_account_metadata_keys, accountIdentifier.sub_account.metadata);
    } catch (e) {
      throw new ParserError(`${e.message}: account metadata keys mismatch`);
    }
  }

  /**
   * amountMatch returns an error if amount does not meet an AmountDescription.
   *
   * @param {AmountDescription} amountDescription - describe an amount.
   * @param {Rosetta:Amount} amount - amount value.
   * @throws {ParserError} thrown if amount is missing or populated, or amount does not meet an AmountDescription.
   */
  amountMatch(amountDescription, amount) {
    if (amountDescription == null) {
      return;
    }

    if (amount == null) {
      if (amountDescription.exists) {
        throw new ParserError(`amount is missing`);
      }

      return;
    }

    if (!amountDescription.exists) {
      throw new ParserError(`amount is populated`);
    }

    if (!amountDescription.sign.match(amount)) {
      throw new ParserError(`amount sign of ${amount.value} was not ${amountDescription.sign.toString()}`);
    }

    if (amountDescription.currency == null) {
      return;
    }

    if (amount.currency == null || Hash(amount.currency) !== Hash(amountDescription.currency)) {
      throw new ParserError(`Currency ${amountDescription.currency} is not ${amount.currency}`);
    }
  }

  /**
   * operationMatch returns an error if operation does not match a OperationDescription.
   *
   * @param {Rosetta:Operation} operation - contain all balance-changing information within a transaction.
   * @param {OperationDescription[]} operationsDescriptionArray - describe an operation.
   * @param {Match[]} matchesArray - contains all operations matching a given OperationDescription.
   * @return {boolean} - is matched or not.
   */
  operationMatch(operation, operationsDescriptionArray, matchesArray) {
    for (let i = 0; i < operationsDescriptionArray.length; ++i) {
      const des = operationsDescriptionArray[i];

      if (matchesArray[i] != null && !des.allow_repeats) continue;
      if (des.type.length > 0 && des.type !== operation.type) continue;

      try {
        this.accountMatch(des.account, operation.account);
        this.amountMatch(des.amount, operation.amount);
        this.metadataMatch(des.metadata, operation.metadata);
        this.coinActionMatch(des.coin_action, operation.coin_action);

      } catch (e) {
        continue;
      }

      if (matchesArray[i] == null) {
        matchesArray[i] = new Match();
      }

      if (operation.amount != null) {
        const val = AmountValue(operation.amount);

        matchesArray[i].amounts.push(val);
      } else {
        matchesArray[i].amounts.push(null);
      }

      matchesArray[i].operations.push(operation);
      return true;
    }

    return false;
  }

  /**
   * Check operations array for equal amounts.
   *
   * @param {Rosetta:Operation[]} operationsArray - array of operations.
   * @throws {ParserError} thrown if operations array empty or if a slice of operations does not have equal amounts.
   */
  equalAmounts(operationsArray) {
    if (operationsArray.length === 0) {
      throw new ParserError(`cannot check equality of 0 operations`);
    }

    const val = AmountValue(operationsArray[0].amount);

    for (let op of operationsArray) {
      const otherVal = AmountValue(op.amount);

      if (val !== otherVal) {
        throw new ParserError(`${op.amount.value} is not equal to ${operationsArray[0].amount.value}`);
      }
    }
  }

  /**
   * Check two operations with opposite amounts.
   *
   * @param {Rosetta:Operation} operationA - one operation.
   * @param {Rosetta:Operation} operationB - another operation.
   * @throws {ParserError} thrown if two operations do not have opposite amounts or not equal.
   */
  oppositeAmounts(operationA, operationB) {
    const valA = AmountValue(operationA.amount);
    const valB = AmountValue(operationB.amount);

    if (new Sign(valA).toString() === new Sign(valB).toString()) {
      throw new ParserError(`${valA} and ${valB} have the same sign`);
    }

    if (Math.abs(valA) !== Math.abs(valB)) {
      throw new ParserError(`${valA} and ${valB} are not equal`);
    }
  }

  /**
   * Check operations array for equal addresses.
   *
   * @param {Rosetta:Operation[]} operations - array of operations.
   * @throws {ParserError} thrown if a slice of operations do not have equal addresses.
   */
  equalAddresses(operations) {
    if (operations.length <= 1) {
      throw new ParserError(`Cannot check address equality of ${operations.length} operations`);
    }

    let base;

    for (let op of operations) {
      if (op.account == null) {
        throw new ParserError(`account is null`);
      }

      if (!base) {
        base = op.account.address;
        continue;
      }

      if (base !== op.account.address) {
        throw new ParserError(`${base} is not equal to ${op.account.address}`);
      }
    }
  }

  /**
   * Check match index
   *
   * @param {Match[]} matchesArray - contains all operations matching a given OperationDescription.
   * @param {number} index - index of operations matching.
   * @throws {ParserError} thrown if match index not valid.
   */
  matchIndexValid(matchesArray, index) {
    if (typeof index != 'number') {
      throw new ParserError(`Index must be a number`);
    }

    if (index >= matchesArray.length) {
      throw new ParserError(`Match index ${index} out of range`);
    }

    if (matchesArray[index] == null) {
      throw new ParserError(`Match index ${index} is null`);
    }
  }

  /**
   * Check operations
   *
   * @param {number[][]} requests2dArray - array for check.
   * @param {Match[]} matchesArray - contains all operations matching a given OperationDescription.
   * @param {function} validCallback - callback function.
   * @throws {ParserError} thrown if index not valid or validCallback not a function.
   */
  checkOps(requests2dArray, matchesArray, validCallback) {
    for (let batch of requests2dArray) {
      const ops = [];

      for (let reqIndex of batch) {
        try {
          this.matchIndexValid(matchesArray, reqIndex);
        } catch (e) {
          throw new ParserError(`${e.message}: index ${reqIndex} not valid`);
        }
        ops.push(...matchesArray[reqIndex].operations);
      }

      if (typeof validCallback !== 'function') {
        throw new ParserError(`validCallback must be a function`);
      }

      validCallback(ops);
    }
  }

  /**
   * ExpectedOperation returns an error if an observed operation
   * differs from the intended operation. An operation is considered
   * to be different from the intent if the AccountIdentifier,
   * Amount, or Type has changed.
   *
   * @param {Rosetta:Operation} intentOperation - intent operation.
   * @param {Rosetta:Operation} observedOperation - observed operation.
   * @throws {ParserError} thrown if an observed operation differs from the intended operation.
   */
  expectedOperation(intentOperation, observedOperation) {
    if (Hash(intentOperation.account) !== Hash(observedOperation.account)) {
      throw new ParserError(`Intended Account ${intentOperation.account} did not ` +
      `match observed account ${observedOperation.account}`);
    }

    if (Hash(intentOperation.amount) !== Hash(observedOperation.amount)) {
      throw new ParserError(`Intended amount ${intentOperation.amount} did not ` +
      `match observed amount ${observedOperation.amount}`);
    }

    if (intentOperation.type !== observedOperation.type) {
      throw new ParserError(`Intended type ${intentOperation.type} did not ` +
      `match observed type ${observedOperation.type}`);
    }
  }

  /**
   * ExpectedOperations returns an error if a slice of intended
   * operations differ from observed operations. Optionally,
   * it is possible to error if any extra observed operations
   * are found or if operations matched are not considered
   * successful.
   *
   * @param {Rosetta:Operation[]} intentOperations - intent operations.
   * @param {Rosetta:Operation[]} observedOperations - observed operations.
   * @param {boolean} errExtra - is possible to error if any extra observed operations are found.
   * @param {boolean} confirmSuccess - check operation success.
   * @throws {ParserError} thrown if a slice of intended operations differ from observed operations.
   */
  expectedOperations(intentOperations, observedOperations, errExtra = false, confirmSuccess = false) {
    if (!Array.isArray(intentOperations))
      throw new ParserError('intentOperations must be an array');

    if (!Array.isArray(observedOperations))
      throw new ParserError('observedOperations must be an array');

    const matches = {};
    const failedMatches = [];

    for (let observed of observedOperations) {
      let foundMatch = false;

      for (let i = 0; i < intentOperations.length; ++i) {
        const intent = intentOperations[i];
        if (matches[i] != null) continue;

        try {
          this.expectedOperation(intent, observed);
        } catch (e) {
          continue;
        }

        if (confirmSuccess) {
          let obsSuccess;
          try {
            obsSuccess = this.asserter.OperationSuccessful(observed);
          } catch (e) {
            throw new ParserError(`Unable to check operation success: ${e.message}`);
          }

          if (!obsSuccess) {
            failedMatches.push(observed);
          }
        }

        matches[i] = true;
        foundMatch = true;
        break;
      }

      if (!foundMatch && errExtra) {
        throw new ParserError(`Found extra operation: ${JSON.stringify(observed)}`);
      }
    }

    const missingIntent = [];
    for (let i = 0; i < intentOperations.length; ++i) {
      if (matches[i] == null) missingIntent.push(i);
    }

    if (missingIntent.length > 0) {
      let errMessage = `Could not intent match ${JSON.stringify(missingIntent)}`;

      if (failedMatches.length > 0) {
        errMessage = `${errMessage}: found matching ops with unsuccessful status: ${errMessage}`;
      }

      throw new ParserError(errMessage);
    }
  }

  /**
   * ExpectedSigners returns an error if a slice of SigningPayload
   * has different signers than what was observed (typically populated
   * using the signers returned from parsing a transaction).
   *
   * @param {Rosetta:SigningPayload[]} intentSigningPayloadArray - SigningPayload array.
   * @param {Rosetta:AccountIdentifier[]} observedArray - observed array.
   * @throws {ParserError} thrown if a slice of SigningPayload has different signers than what was observed.
   */
  expectedSigners(intentSigningPayloadArray, observedArray) {
    if (!Array.isArray(intentSigningPayloadArray))
      throw new ParserError('intentSigningPayloadArray must be an array');

    if (!Array.isArray(observedArray))
      throw new ParserError('observedArray must be an array');

    try {
      this.asserter.StringArray('observed signers', observedArray);
    } catch (e) {
      throw new ParserError(`Found duplicate signer: ${e.message}`);
    }

    const intendedSigners = {};
    for (let payload of intentSigningPayloadArray) {
      intendedSigners[payload.address] = true;
    }

    const seenSigners = {};
    const unmatched = {};

    for (let signer of observedArray) {
      if (intendedSigners[signer] == null) {
        unmatched.push(signer);
      } else {
        seenSigners[signer] = true;
      }
    }

    for (let i = 0; i < Object.keys(intendedSigners).length; ++i) {
      if (seenSigners[i] == null) {
        throw new ParserError(`Could not find match for intended signer: ${i}`);
      }
    }

    if (unmatched.length !== 0) {
      throw new ParserError(`Found unexpected signers: ${JSON.stringify(unmatched)}`);
    }
  }

  /**
   * Ensures collections of operations have either equal or opposite amounts.
   *
   * @param {Descriptions} descriptions - operation descriptions.
   * @param {Match[]} matchesArray - contains all operations matching a given operation description.
   * @throws {ParserError} thrown if operation description not equal to expected.
   */
  comparisonMatch(descriptions, matchesArray) {
    try {
      this.checkOps(descriptions.equal_amounts, matchesArray, this.equalAmounts);
    } catch (e) {
      throw new ParserError(`${e.message}: operation amounts are not equal`);
    }

    try {
      this.checkOps(descriptions.equal_addresses, matchesArray, this.equalAddresses);
    } catch (e) {
      throw new ParserError(`${e.message}: operation addresses are not equal`);
    }

    for (let amountMatch of descriptions.opposite_amounts) {
      if (amountMatch.length !== ExpectedOppositesLength) {
        throw new ParserError(`Cannot check opposites of ${amountMatch.length} operations`);
      }

      // Compare all possible pairs
      try {
        this.matchIndexValid(matchesArray, amountMatch[0]);
      } catch (e) {
        throw new ParserError(`${e.message}: opposite amounts comparison error`);
      }

      try {
        this.matchIndexValid(matchesArray, amountMatch[1]);
      } catch (e) {
        throw new ParserError(`${e.message}: opposite amounts comparison error`);
      }

      const match0Ops = matchesArray[amountMatch[0]].operations;
      const match1Ops = matchesArray[amountMatch[1]].operations;

      this.equalAmounts(match0Ops);
      this.equalAmounts(match1Ops);

      this.oppositeAmounts(match0Ops[0], match1Ops[0]);
    }
  }

  /**
   * MatchOperations attempts to match a slice of operations with a slice of
   * OperationDescriptions (high-level descriptions of what operations are
   * desired). If matching succeeds, a slice of matching operations in the
   * mapped to the order of the descriptions is returned.
   *
   * @param {Descriptions} descriptions - operation descriptions.
   * @param {Rosetta:Operation[]} operationsArray - array of operations.
   * @return {Match[]} - slice of matching operations in the mapped to the order of the descriptions.
   * @throws {ParserError} thrown if operations or description arrays empty or problem with match for operation.
   */
  MatchOperations(descriptions, operationsArray) {
    if (operationsArray.length === 0) {
      throw new ParserError(`Unable to match anything to zero operations`);
    }

    const operationDescriptions = descriptions.operation_descriptions;
    const matches = new Array(operationDescriptions.length).fill(null);

    if (operationDescriptions.length === 0) {
      throw new ParserError(`No descriptions to match`);
    }

    for (let i = 0; i < operationsArray.length; ++i) {
      const op = operationsArray[i];
      const matchFound = this.operationMatch(op, operationDescriptions, matches);

      if (!matchFound && descriptions.err_unmatched) {
        throw new ParserError(`Unable to find match for operation at index ${i}`);
      }
    }

    for (let i = 0; i < matches.length; ++i) {
      if (matches[i] === null && !descriptions.operation_descriptions[i].optional) {
        throw new ParserError(`Could not find match for description ${i}`);
      }
    }

    try {
      this.comparisonMatch(descriptions, matches);
    } catch (e) {
      throw new ParserError(`${e.message}: group descriptions not met`);
    }

    return matches;
  }
}

RosettaParser.Match = Match;

module.exports = RosettaParser;
