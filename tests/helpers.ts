// The engine hands the mod each path as the platform spells it: on Windows `C:\proj\src\app.ts` for
// `/proj/src/app.ts`. The fake disks of the tests are kept by the POSIX spelling, whichever the mod
// asks by: each path a fake is handed goes through this first.
export const posix = (path: string) => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
