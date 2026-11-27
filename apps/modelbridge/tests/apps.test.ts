import { expect, test } from 'bun:test'
import { appProtocols, configurableApps } from '@modelbridge/runtime/apps'
import { apps, usageAppLabels } from '../src/apps'

test('all supported harness profiles are configurable from the Apps tab', () => {
  for (const id of configurableApps)
    expect(apps.find((app) => app.id === id)).toMatchObject({
      automatic: true,
      protocol: appProtocols[id],
    })
  expect(usageAppLabels.deepseek).toBe('DeepSeek Harness')
  expect(usageAppLabels.opencode).toBe('OpenCode')
})
