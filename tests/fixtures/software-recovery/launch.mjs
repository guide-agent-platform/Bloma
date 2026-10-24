import { app } from 'electron'
import { pathToFileURL } from 'node:url'
import(pathToFileURL(process.env.SOFTWARE_CRASH_RUNTIME).href).then(api => api.main()).then(() => app.exit(0), error => { console.error(error); app.exit(1) })
