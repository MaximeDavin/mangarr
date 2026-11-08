// Pieces shared by the series detail page and its modals.

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { type client, orpc } from "../../api";

export type Series = Awaited<ReturnType<typeof client.series.get>>;

/**
 * Most series procedures answer with the whole series: put it in the cache instead of fetching it
 * again, and let the list's counts and covers catch up.
 */
export function useSetSeries() {
  const queryClient = useQueryClient();
  return useCallback(
    (series: Series) => {
      queryClient.setQueryData(orpc.series.get.queryKey({ input: { id: series.id } }), series);
      void queryClient.invalidateQueries({ queryKey: orpc.series.list.key() });
    },
    [queryClient],
  );
}

/** For changes that don't return the series (search terms, a grab): fetch it again. */
export function useRefreshSeries() {
  const queryClient = useQueryClient();
  return useCallback(
    (id: number) => queryClient.invalidateQueries({ queryKey: orpc.series.get.queryKey({ input: { id } }) }),
    [queryClient],
  );
}
