// The settings surfaces' door to the shared config-record cache. The hook, the
// key and the writers live in `@/app/hooks/use-config-record` (desktop's path)
// — this file used to hold a byte-identical second copy, which meant two places
// to teach about the "Applies to" profile scope and one cache key spelled
// twice.
export {
  HERMES_CONFIG_KEY,
  hermesConfigCacheWriter,
  hermesConfigKey,
  invalidateHermesConfig,
  setHermesConfigCache,
  useHermesConfigRecord
} from '@/app/hooks/use-config-record'
