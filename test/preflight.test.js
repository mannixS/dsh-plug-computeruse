import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BROKEN_INSTALL_CODES,
  checkInstallation,
  classifyFailure,
  nestedNodeModules,
  packageDirectoryOfThisModule,
  repairAdvice,
  REQUIRED_DEPENDENCIES,
} from '../src/preflight.js'

test('a healthy install reports ok without calling repair advice', async () => {
  const result = await checkInstallation({ resolve: () => 'file:///x/index.js' })
  assert.deepEqual(result, { ok: true })
})

test('every declared dependency is actually checked', async () => {
  const asked = []
  await checkInstallation({ resolve: specifier => { asked.push(specifier); return 'x' } })
  assert.deepEqual(asked, REQUIRED_DEPENDENCIES.map(dependency => dependency.name))
})

test('a broken symlink is classified as an unreadable install, not missing', () => {
  const eperm = Object.assign(new Error('EPERM: operation not permitted, stat \'C:\\long\\path\''), { code: 'EPERM' })
  assert.equal(classifyFailure(eperm), 'unreadable')
  const eacces = Object.assign(new Error('denied'), { code: 'EACCES' })
  assert.equal(classifyFailure(eacces), 'unreadable')
  // Node sometimes reports a realpath failure with no code at all.
  assert.equal(classifyFailure(new Error('operation not permitted, realpath')), 'unreadable')
})

test('a genuinely absent package is classified as missing', () => {
  const notFound = Object.assign(new Error("Cannot find package 'x'"), { code: 'ERR_MODULE_NOT_FOUND' })
  assert.equal(classifyFailure(notFound), 'missing')
  assert.equal(classifyFailure(Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' })), 'missing')
  assert.equal(classifyFailure(new Error('something else')), 'unknown')
})

test('the nested node_modules path is derived from the package directory', () => {
  assert.equal(nestedNodeModules('C:\\a\\b\\dsh-plug-computeruse'), 'C:\\a\\b\\dsh-plug-computeruse\\node_modules')
  assert.equal(nestedNodeModules('/home/u/pkg/'), '/home/u/pkg/node_modules')
  assert.equal(nestedNodeModules(''), undefined)
  assert.equal(nestedNodeModules(undefined), undefined)
})

test('repair advice names the exact folder to delete', () => {
  const advice = repairAdvice('C:\\profiles\\desktop\\node_modules\\dsh-plug-computeruse', 'unreadable')
  assert.match(advice, /cannot read one of its dependencies/)
  assert.match(advice, /Disable this plugin/)
  // The actionable part: the literal directory, so the user does not have to guess.
  assert.match(advice, /C:\\profiles\\desktop\\node_modules\\dsh-plug-computeruse\\node_modules/)
  assert.match(advice, /Enable the plugin again/)
})

test('missing dependencies get their own wording', () => {
  const advice = repairAdvice('/p/pkg', 'missing')
  assert.match(advice, /missing from the profile/)
})

test('a failure message lists the dependency, the unreadable kind, and the repair', async () => {
  const resolve = specifier => {
    if (specifier === '@trycua/cua-driver') {
      throw Object.assign(new Error('EPERM: operation not permitted, realpath'), { code: 'EPERM' })
    }
    return 'file:///ok.js'
  }
  const result = await checkInstallation({
    resolve,
    packageDirectory: 'C:\\profiles\\desktop\\node_modules\\dsh-plug-computeruse',
  })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'unreadable')
  assert.equal(result.failures.length, 1)
  assert.match(result.message, /could not load its dependencies/)
  assert.match(result.message, /@trycua\/cua-driver/)
  assert.match(result.message, /bundled Cua Driver SDK/)
  assert.match(result.message, /node_modules/)
})

test('an unreadable failure wins over a missing one in the summary', async () => {
  const resolve = specifier => {
    if (specifier === '@trycua/cua-driver') {
      throw Object.assign(new Error("Cannot find package"), { code: 'ERR_MODULE_NOT_FOUND' })
    }
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
  }
  const result = await checkInstallation({ resolve, packageDirectory: '/p/pkg' })
  assert.equal(result.kind, 'unreadable')
  assert.equal(result.failures.length, 2)
})

test('the module can locate its own package directory', () => {
  const directory = packageDirectoryOfThisModule()
  assert.equal(typeof directory, 'string')
  assert.match(directory, /dsh-cua$/)
})

test('the real install resolves, so the check passes in this checkout', async () => {
  // Guards against a check that would fire on every healthy machine.
  const result = await checkInstallation()
  assert.equal(result.ok, true, result.ok ? '' : result.message)
})

test('broken codes cover the permission family', () => {
  assert.ok(BROKEN_INSTALL_CODES.has('EPERM'))
  assert.ok(BROKEN_INSTALL_CODES.has('EACCES'))
  assert.ok(!BROKEN_INSTALL_CODES.has('ERR_MODULE_NOT_FOUND'))
})
