/**
 * Host half of the Session deletion bundle.
 *
 * The Workspace registry can archive a Session but never deletes its files, and
 * the Client rows expose no delete action. This plugin adds both: a Host route
 * that removes one stored Session directory after ownership and activity
 * checks, and a Client row-menu entry that asks for confirmation first.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry']

/** Route prefix owned by this plugin; the Client half posts here. */
const API_PREFIX = '/api/dsh-session-delete'

/** Session ids are escaped to one path segment; reject anything else up front. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/

/** Stored log file names inside one Session directory; older generations stay readable. */
const LOG_FILE = /^session(\.v\d+)?\.jsonl(\.zstd)?$/

/** One failure the Client renders verbatim. */
class RequestError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

/**
 * Build one JSON response.
 * @param status - HTTP status.
 * @param payload - serializable body.
 * @returns the fetch handler response.
 */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Sum the bytes one directory tree holds.
 * @param dir - directory to measure.
 * @returns total size in bytes.
 */
async function directorySize(dir) {
  let total = 0
  const pending = [dir]
  while (pending.length > 0) {
    const current = pending.pop()
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(full)
        continue
      }
      try {
        total += (await fs.stat(full)).size
      } catch {
        // A file that vanished mid-walk contributes nothing.
      }
    }
  }
  return total
}

/**
 * Remove one Session directory, retrying a transient Windows sharing violation.
 * @param dir - the directory to remove.
 */
async function removeDirectory(dir) {
  // The log is opened with delete sharing, so a removal normally succeeds even
  // while the Host holds the file. A scanner or an indexer can still hold the
  // directory for a moment, and that clears on its own.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch (caught) {
      const code = caught?.code
      const transient = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY'
      if (!transient || attempt >= 2) {
        if (transient) {
          throw new RequestError(409, 'session/locked', `Another program is holding this Session directory: ${dir}`)
        }
        throw caught
      }
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }
}

/**
 * Delete one stored Session and drop its archive and pin entries.
 * @param ctx - Host context.
 * @param sessionId - the Session to remove.
 * @returns what was removed.
 */
async function deleteSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    throw new RequestError(400, 'session/invalid-id', 'Session id is not a valid stored identity')
  }

  // Running work holds the Session open: the same waterfall the archive command
  // consults, so a turn, job, subagent step, or schedule wakes up first.
  const activity = typeof ctx.waterfall === 'function'
    ? await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    : []
  if (Array.isArray(activity) && activity.length > 0) {
    throw new RequestError(409, 'session/busy', 'Session still has running activity; stop it before deleting')
  }

  // A Session with a live store entry is normal, not a blocker: the Host keeps
  // every listed Session live (the sidebar needs per-row state), and its log is
  // opened for sharing, so the directory can still be removed. Refusing on a live
  // entry rejected every row. The activity check above is the real guard; a live
  // entry is only reported back so the Client can tell the user to refresh.
  const sessions = ctx.get('sessions')
  const live = sessions !== undefined && typeof sessions.get === 'function' && sessions.get(sessionId) !== undefined

  const snapshot = await ctx.sessionPersistence.stat(sessionId)
  const location = snapshot === undefined ? undefined : snapshot.location
  if (snapshot === undefined || location === undefined || location.kind !== 'jsonl') {
    // Never materialized: nothing to remove, but stale registry entries may remain.
    await ctx.workspaceRegistry.unarchiveSession(sessionId)
    await ctx.workspaceRegistry.unpinSession(sessionId)
    return { deleted: false, reason: 'not-materialized', sessionId, live }
  }

  const logPath = location.path
  if (typeof logPath !== 'string' || !LOG_FILE.test(path.basename(logPath))) {
    throw new RequestError(409, 'session/unexpected-layout', `Refusing to delete an unexpected log path: ${String(logPath)}`)
  }
  const directory = path.dirname(logPath)
  if (path.basename(directory) !== sessionId) {
    throw new RequestError(409, 'session/unexpected-layout', `Session directory does not match its id: ${directory}`)
  }
  // Project directories are the Harness's own "<root>/--<cwd>--/<session>" layout;
  // anything else is not a Session directory and must not be removed recursively.
  if (!path.basename(path.dirname(directory)).startsWith('--')) {
    throw new RequestError(409, 'session/unexpected-layout', `Session directory is not inside a project directory: ${directory}`)
  }

  const bytes = await directorySize(directory)
  await removeDirectory(directory)

  // Both removals accept ids whose Session is gone, so order after the unlink.
  await ctx.workspaceRegistry.unarchiveSession(sessionId)
  await ctx.workspaceRegistry.unpinSession(sessionId)
  return { deleted: true, sessionId, path: directory, bytes, live }
}

/**
 * Register the deletion route for the Client half.
 * @param ctx - Host context.
 */
export function apply(ctx) {
  const route = {
    path: `${API_PREFIX}/delete`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        return jsonResponse(400, { ok: false, code: 'request/invalid-json', error: 'Request body must be JSON' })
      }
      try {
        return jsonResponse(200, { ok: true, data: await deleteSession(ctx, body?.sessionId) })
      } catch (caught) {
        const status = caught instanceof RequestError ? caught.statusCode : 500
        return jsonResponse(status, {
          ok: false,
          ...(caught instanceof RequestError ? { code: caught.code } : {}),
          error: caught instanceof Error ? caught.message : String(caught),
        })
      }
    },
  }

  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register(route)
    return () => {
      try {
        dispose()
      } catch {
        // A disposed connection already released the route.
      }
    }
  }, 'session-delete: delete route')

  ctx.logger?.debug?.('session-delete: route ready at %s', route.path)
}
