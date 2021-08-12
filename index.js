import _ from 'lodash';
import {
  ApolloProvider,
  gql,
  ApolloClient,
  ApolloLink,
  InMemoryCache,
} from '@apollo/client';

import {withApollo} from '@apollo/client/react/hoc';
import {getApolloContext} from '@apollo/client/react/context';
import {ErrorLink} from '@apollo/client/link/error';
import {BatchHttpLink} from '@apollo/client/link/batch-http';
import {RetryLink} from '@apollo/client/link/retry';
import SerializingLink from 'apollo-link-serialize';

import {persistCache} from './src/cache';
import {identify} from './src/utils';
import {parseType} from './src/parser';
import {useQuery, useLazyQuery, useMutation} from './src/hooks';
import {createQueueLink} from './src/links';

function newClient(options = {}) {
  const httpLink = new BatchHttpLink({
    uri: 'http://localhost:8080/graphql',
  });
  const retryLink = new RetryLink({attempts: {max: 1}});
  const errorLink = new ErrorLink(options.onError || (err => {}));
  const serializingLink = new SerializingLink();
  const queueLink = new createQueueLink();

  const cacheOptions = {
    dataIdFromObject: obj => [obj.__typename || '', identify(obj)].join('_'),
  };

  const apolloOptions = {
    link: ApolloLink.from([
      errorLink,
      queueLink,
      serializingLink,
      retryLink,
      httpLink,
    ]),
    cache: new InMemoryCache(cacheOptions),
    defaultOptions: {
      watchQuery: {
        fetchPolicy: 'cache-and-network',
        refetchWritePolicy: 'overwrite',
      },
    },
  };

  const clientOptions = _.defaultsDeep(apolloOptions, options);
  const client = new ApolloClient(clientOptions);

  client.pendingOperations = queueLink.operations;
  client.persistCache = storage => {
    return persistCache(client.cache, storage).then(() =>
      queueLink.load(client),
    );
  };
  client.setNetworkState = isConnected => {
    isConnected ? queueLink.open() : queueLink.close();
    client.defaultOptions.watchQuery.fetchPolicy = isConnected
      ? 'cache-and-network'
      : 'cache-only';
  };

  return client;
}

export {
  ApolloProvider as ClientProvider,
  withApollo as withClient,
  getApolloContext as getContext,
  gql,
  useQuery,
  useLazyQuery,
  useMutation,
  newClient,
  parseType,
};
