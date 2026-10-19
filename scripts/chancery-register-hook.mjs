// Installed with node --import before the artifact importer runs.
import { register } from 'node:module'

register('./chancery-load-hook.mjs', import.meta.url)
