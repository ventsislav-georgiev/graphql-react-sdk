import * as cachePersist from 'apollo3-cache-persist';

export function persistCache(cache, storage) {
  return cachePersist.persistCache({
    cache,
    storage: storage,
  });
}
