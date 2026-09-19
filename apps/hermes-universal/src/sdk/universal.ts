/**
 * `@hermes/plugin-sdk` as universal serves it: desktop's barrel, verbatim, plus
 * what only universal has.
 *
 * `sdk/index.ts` is desktop's file and is never edited here. A name a universal
 * plugin needs and desktop's SDK does not carry is exported from THIS module,
 * which is what the public specifier resolves to — the vite alias and the
 * tsconfig path for a bundled plugin, `sdk/runtime.ts`'s namespace for a
 * runtime-loaded one — so both kinds of plugin see one surface. An explicit
 * export below wins over the same name arriving through `export *`.
 */
export * from './index'

// The accent picker's drag (`plugins/accent/picker.tsx`). Universal's primitive
// ends a drag on `pointercancel` too, which a touch gesture needs.
export { startPointerDrag } from '@/lib/pointer-drag'
