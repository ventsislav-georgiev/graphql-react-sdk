import _ from 'lodash';
import {getApolloContext} from '@apollo/client/react/context';

export function identify(data) {
  return _.isObject(data)
    ? data.id || data._id || data.Id || data.ID
    : undefined;
}

export function getClient() {
  const context = getApolloContext();
  return _.get(context, '_currentValue.client');
}
