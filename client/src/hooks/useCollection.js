import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

export function useCollection(name) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.get(`/${name}`));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = useCallback(
    async (fn) => {
      try {
        await fn();
        setError(null);
        await refresh();
      } catch (err) {
        setError(err.message);
      }
    },
    [refresh]
  );

  return {
    items,
    loading,
    error,
    refresh,
    create: (payload) => run(() => api.post(`/${name}`, payload)),
    update: (id, payload) => run(() => api.patch(`/${name}/${id}`, payload)),
    remove: (id) => run(() => api.remove(`/${name}/${id}`))
  };
}
