import { useQuery } from '@tanstack/react-query';
import { ScaleCatalogSchema } from '@psychometr/shared';
import { sessionClient, useSession } from './session.js';

/** Published scale passports and item texts. Any signed-in user may read them. */
export function useScaleCatalog() {
  const { user } = useSession();
  return useQuery({
    queryKey: ['scale-catalog', user?.id],
    queryFn: ({ signal }) => sessionClient.request('/api/scales', ScaleCatalogSchema, { signal }),
    enabled: Boolean(user),
  });
}
