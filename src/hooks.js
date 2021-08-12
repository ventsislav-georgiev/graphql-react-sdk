import _ from 'lodash';
import uuidv4 from 'uuid/v4';
import {
  useQuery as apolloUseQuery,
  useLazyQuery as apolloUseLazyQuery,
  useMutation as apolloUseMutation,
  gql,
} from '@apollo/client';

import {identify, getClient} from './utils';

function addTypePolicyIfNecessary(gqlQuery) {
  if (!gqlQuery.__itemtype__) {
    return;
  }

  const cache = getClient().cache;
  const typeNameCamelCase = gqlQuery.__itemtype__.typeNameCamelCase;
  const queryTypePolicy = cache.policies.getTypePolicy('Query');
  const typePolicy = queryTypePolicy.fields[typeNameCamelCase];

  if (typePolicy) {
    return;
  }

  cache.policies.addTypePolicies({
    Query: {
      fields: {
        [typeNameCamelCase]: {
          read(__, {args, toReference}) {
            return toReference({
              __typename: gqlQuery.__itemtype__.typeName,
              id: args.id,
            });
          },
        },
      },
    },
  });
}

export function updateCache({
  cache,
  queryType,
  itemType,
  optimisticResponse,
  data,
  id,
}) {
  switch (queryType) {
    case 'edit': {
      const fields = {};
      Object.keys(data).forEach(key => {
        fields[key] = () => data[key];
      });
      cache.modify({
        id: cache.identify(data),
        fields,
      });
      break;
    }
    case 'add': {
      cache.modify({
        fields: {
          [itemType.typeNamePluralCamelCase]: (existingRefs = []) => {
            const newRef = cache.writeFragment({
              data: optimisticResponse.result,
              fragment: gql`
                fragment New${itemType.typeName} on ${itemType.typeName} {
                  ${Object.keys(optimisticResponse.result).join('\n')}
                }
              `,
            });
            return existingRefs.concat(newRef);
          },
        },
      });
      break;
    }
    case 'remove': {
      cache.modify({
        fields: {
          [itemType.typeNamePluralCamelCase]: (
            existingRefs = [],
            {readField},
          ) => {
            return existingRefs.filter(
              n => readField(itemType.idFieldName, n) !== id,
            );
          },
        },
      });
      break;
    }
  }
}

export function useQuery(query, options = {}) {
  const client = getClient();
  addTypePolicyIfNecessary(query);
  options = _.merge({context: {client}}, query.__options__, options);
  return apolloUseQuery(query, options);
}

export function useLazyQuery(query, options = {}) {
  const client = getClient();
  addTypePolicyIfNecessary(query);
  options = _.merge({context: {client}}, query.__options__, options);
  return apolloUseLazyQuery(query, options);
}

export function useMutation(mutation, options) {
  const client = getClient();
  const dataFromMutateFn = {};
  options = _.merge(
    {
      context: {
        client,
        tracked: true,
        queryType: mutation.__querytype__,
        itemType: mutation.__itemtype__,
        dataFromMutateFn,
        get serializationKey() {
          return this.dataFromMutateFn.id;
        },
      },
      update(cache) {
        updateCache({
          cache,
          queryType: mutation.__querytype__,
          itemType: mutation.__itemtype__,
          ...dataFromMutateFn,
        });
      },
      onQueryUpdated: () =>
        mutation.__querytype__ === 'add' &&
        client.defaultOptions.watchQuery.fetchPolicy === 'cache-and-network',
    },
    mutation.__options__,
    options,
  );

  const [mutateFn, stateVars] = apolloUseMutation(mutation, options);

  const mutateFnWrapper = (data, mutateFnOptions = {}) => {
    let id = data;
    if (_.isObject(data)) {
      id = data[mutation.__itemtype__.idFieldName] || identify(data);
    }
    if (!id && options && options.variables && options.variables.id) {
      id = options.variables.id;
    }
    if (!id) {
      id = `temp_${uuidv4()}`;
    }

    const optimisticResponse = {
      result: {
        __typename: mutation.__itemtype__.typeName,
        id,
        [mutation.__itemtype__.idFieldName]: id,
        ...data,
      },
    };

    dataFromMutateFn.id = id;
    dataFromMutateFn.data = data;
    dataFromMutateFn.optimisticResponse = optimisticResponse;

    const mutateOptions = _.merge(
      {
        variables: {
          id,
          ...data,
        },
        optimisticResponse,
      },
      mutateFnOptions || {},
    );

    const promise = mutateFn(mutateOptions);
    if (client.defaultOptions.watchQuery.fetchPolicy === 'cache-and-network') {
      return promise;
    } else {
      return Promise.resolve().then(() =>
        options.update(client.cache, optimisticResponse),
      );
    }
  };

  return [mutateFnWrapper, stateVars];
}
