// Opens an http(s) address in the system Safari view. The parish
// WebView stays where it was. Refuses anything that is not a plain
// http(s) address.

import { assertSystemHttpUrl } from './awayNavigation.js'

export async function openSystemBrowser(url) {
  const target = assertSystemHttpUrl(url)
  if (!target) return false
  const { Browser } = await import('@capacitor/browser')
  await Browser.open({ url: target, toolbarColor: '#FBF8F2' })
  return true
}
