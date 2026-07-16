import { useStatusbarItems } from './hooks/use-statusbar-items'
import { StatusbarControls } from './statusbar-controls'

// The connected bottom statusbar: assembles the item descriptors from stores
// (use-statusbar-items) and hands them to the dumb renderer. Mounted once, below
// the routed content, by MobileController.
export function Statusbar() {
  const { leftStatusbarItems, statusbarItems } = useStatusbarItems()

  return <StatusbarControls items={statusbarItems} leftItems={leftStatusbarItems} />
}
