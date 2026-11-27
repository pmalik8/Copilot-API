import { useEffect, useState } from 'react'
import type { AppConfigurationPreview } from '@modelbridge/runtime/apps'
import { apps } from './apps'
import { failure } from './format'
import type { AppRestoreTarget } from './types'

type Preview = Pick<
  AppConfigurationPreview,
  'id' | 'before' | 'after' | 'changes'
> & { warnings?: string[] }

const name = (app: AppRestoreTarget['app']) =>
  apps.find((item) => item.id === app)?.name ?? app

export function RestoreAppSettings({
  active,
  onRestored,
  onlyWhenAvailable = false,
}: {
  active: boolean
  onRestored: () => void
  onlyWhenAvailable?: boolean
}) {
  const [targets, setTargets] = useState<AppRestoreTarget[] | null>(null)
  const [selection, setSelection] = useState('')
  const [review, setReview] = useState<{
    target: AppRestoreTarget
    preview: Preview
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!active) return
    let current = true
    setTargets(null)
    setError('')
    void window.modelbridge
      .appRestoreTargets()
      .then((result) => {
        if (!current) return
        if (result.ok) setTargets(result.value)
        else setError(result.error)
      })
      .catch((reason: unknown) => {
        if (current)
          setError(failure(reason, 'Could not load saved app settings.'))
      })
    return () => {
      current = false
    }
  }, [active])

  const selected =
    targets?.find((target) => target.app === selection) ?? targets?.[0]

  async function preview(target: AppRestoreTarget) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result =
        target.app === 'codex' ?
          await window.modelbridge.previewCodexRestore()
        : await window.modelbridge.previewAppRestore(target.app)
      if (result.ok) setReview({ target, preview: result.value })
      else setError(result.error)
    } catch (reason) {
      setError(failure(reason, 'Could not preview the restore.'))
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    if (!review) return
    const app = review.target.app
    setBusy(true)
    setError('')
    try {
      const result =
        app === 'codex' ?
          await window.modelbridge.applyCodex(review.preview.id)
        : await window.modelbridge.applyAppConfig(review.preview.id)
      if (!result.ok) throw new Error(result.error)
      if (app !== 'codex')
        setTargets(
          (previous) => previous?.filter((target) => target.app !== app) ?? [],
        )
      setNotice(`Restored ${name(app)}. Restart it and start a new session.`)
      onRestored()
    } catch (reason) {
      setError(failure(reason, 'Could not restore the app settings.'))
    } finally {
      setReview(null)
      setBusy(false)
    }
  }

  if (onlyWhenAvailable && !selected && !notice) return null
  return (
    <section aria-labelledby="restore-app-settings-title">
      <h2 id="restore-app-settings-title">Restore app settings</h2>
      <p className="muted">
        Roll back only the settings ModelBridge changed. Your sign-ins and
        unrelated settings stay in place.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {targets === null && !error && (
        <p role="status">Checking for backups...</p>
      )}
      {targets?.length === 0 && <p>No app settings to restore.</p>}
      {selected && (
        <div className="actions">
          <label>
            App to restore
            <select
              value={selected.app}
              disabled={busy || review !== null}
              onChange={(event) => {
                setSelection(event.target.value)
                setError('')
                setNotice('')
              }}
            >
              {targets?.map((target) => (
                <option key={target.app} value={target.app}>
                  {name(target.app)}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy || review !== null}
            onClick={() => void preview(selected)}
          >
            Preview restore
          </button>
        </div>
      )}
      {review && (
        <div className="preview">
          <h3>Restore {name(review.target.app)}</h3>
          <p>
            Settings file: <code>{review.target.configPath}</code>
          </p>
          <ul>
            {review.preview.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
          {review.preview.warnings?.map((warning) => (
            <p key={warning} className="notice warn">
              {warning}
            </p>
          ))}
          <div className="config-diff">
            <div>
              <h4>Current (secrets hidden)</h4>
              <pre>{review.preview.before || '(No settings file)'}</pre>
            </div>
            <div>
              <h4>After restore (secrets hidden)</h4>
              <pre>{review.preview.after || '(No settings file)'}</pre>
            </div>
          </div>
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => void apply()}
            >
              Restore original settings
            </button>
            <button disabled={busy} onClick={() => setReview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
