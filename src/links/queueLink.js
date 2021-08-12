/* eslint-disable no-bitwise */

import _ from 'lodash';
import {ApolloLink} from '@apollo/client/link/core';
import {Observable} from '@apollo/client/utilities';
import {gql} from '@apollo/client';
import {print} from 'graphql';
import {updateCache} from '../hooks';
import {identify} from '../utils';

function hashCode(str) {
  let hash = 0;
  if (str.length === 0) {
    return hash;
  }
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return hash;
}

function getOperationKey(operation) {
  const query = print(operation.query);
  const id = identify(operation.variables);
  return `${id}_${hashCode(query)}`;
}

const pendingOperationsTypeName = 'OfflineUsagePendingOperation';
const pendingOperationsFnName = `${pendingOperationsTypeName}s`;
const pendingOperationsFields = `
  id
  args
  __typename
`;
const pendingOperationsList = gql`
query List${pendingOperationsTypeName}s {
  results: ${pendingOperationsFnName} {
    ${pendingOperationsFields}
  }
}
`;

function loadOperations(operations, client) {
  if (operations.__loaded) {
    return;
  }

  const cache = client.cache;

  let data = cache.readQuery({query: pendingOperationsList});
  if (!data || !data.results) {
    data = {results: []};
    cache.writeQuery({query: pendingOperationsList, data});
  }

  console.log('load', data.results.length);
  data.results.forEach(({id, args}) => {
    const {mutation, variables, ctx} = JSON.parse(args);

    removePendingOperation(cache, id);

    console.log('mutate', id);
    client.mutate({
      context: {
        client,
        ...ctx,
      },
      mutation: gql`
        ${mutation}
      `,
      optimisticResponse: ctx.dataFromMutateFn.optimisticResponse,
      update: () => updateCache({cache, ...ctx, ...ctx.dataFromMutateFn}),
      variables,
    });
  });

  operations.__loaded = true;
}

function addEntry(operations, entry) {
  let entries = operations.get(entry.key);
  if (entries) {
    entries.push(entry);
  } else {
    operations.set(entry.key, [entry]);
  }

  const context = entry.operation.getContext();
  const cache = context.client.cache;
  const {serializationKey, tracked, queryType, itemType, dataFromMutateFn} =
    context;

  const data = cache.readQuery({query: pendingOperationsList});
  console.log('add', data.results.length);
  const tmp = [];
  const item = {
    id: entry.key,
    args: JSON.stringify(
      {
        mutation: print(entry.operation.query),
        variables: entry.operation.variables,
        ctx: {serializationKey, tracked, queryType, itemType, dataFromMutateFn},
      },
      (key, val) => {
        if (val != null && typeof val === 'object') {
          if (tmp.indexOf(val) >= 0) {
            return;
          }
          tmp.push(val);
        }
        return val;
      },
    ),
    __typename: pendingOperationsTypeName,
  };

  cache.writeQuery({
    query: pendingOperationsList,
    data: {results: [item, ...data.results]},
  });
}

function removePendingOperation(cache, key) {
  cache.modify({
    fields: {
      [pendingOperationsFnName]: (existingRefs = [], {readField}) => {
        return existingRefs.filter(n => readField('id', n) !== key);
      },
    },
  });
}

function removeEntry(operations, entry) {
  operations.delete(entry.key);
  const context = entry.operation.getContext();
  const cache = context.client.cache;
  removePendingOperation(cache, entry.key);
}

export function createQueueLink() {
  const operations = new Map();
  let isOpen = true;

  const link = new ApolloLink((operation, forward) => {
    if (isOpen) {
      console.log('request');
      return forward(operation);
    }
    console.log('enqueue');
    return new Observable(observer => {
      const opKey = getOperationKey(operation);
      const entry = {operation, forward, observer, key: opKey};

      addEntry(operations, entry);

      return () => {
        console.log('unsubscribe - ' + entry.key);
        removeEntry(operations, entry);
      };
    });
  });

  link.operations = operations;
  link.load = client => {
    loadOperations(operations, client);
  };
  link.close = () => (isOpen = false);
  link.open = () => {
    isOpen = true;
    operations.forEach(entries => {
      const entriesCopy = entries.slice();
      const entry = entriesCopy.pop();

      const entryId =
        entry && entry.operation && identify(entry.operation.variables);
      const isTemp = entryId && _.startsWith(entryId, 'temp_');
      const context = entry.operation.getContext();

      if (isTemp) {
        context.serializationKey = entryId;
        entry.operation.setContext(context);
      }

      entry.forward(entry.operation).subscribe(
        v => {
          const dataResult = _.get(v, 'data.result', {});
          const newId = identify(dataResult);

          if (isTemp && newId) {
            operations.forEach((opValue, opKey) => {
              if (!_.startsWith(opKey, entryId)) {
                console.log(opKey, entryId);
                return;
              }

              opValue.forEach(opEntry => {
                if (
                  opEntry === entry ||
                  !opEntry ||
                  !opEntry.operation ||
                  !opEntry.operation.variables ||
                  !_.startsWith(identify(opEntry.operation.variables), entryId)
                ) {
                  return;
                }

                console.log(
                  `update: ${opEntry.operation.variables.id} to ${newId}`,
                );
                opEntry.operation.variables.id = newId;
              });
            });
          }
          entriesCopy.forEach(e => e.observer.next(v));
          return entry.observer.next(v);
        },
        err => {
          removeEntry(operations, entry);
          entriesCopy.forEach(e => e.observer.error(err));
          return entry.observer.error(err);
        },
        () => {
          removeEntry(operations, entry);
          entriesCopy.forEach(e => e.observer.complete());
          return entry.observer.complete();
        },
      );
    });
  };

  return link;
}
