// Says whether Jenkins can be read from here, judged as the QA report's Jenkins reader judges it
// (scripts/lib/qa/sources/jenkins.ts): same JENKINS_URL default, same credentials, same idea of
// unreachable. Prints one fixed line, a GitHub notice in Actions, and always exits 0: the report
// runs either way, and rows it can't read keep their published answer.
//
//   node --no-warnings scripts/qa-jenkins-check.ts

import { type NetworkFailure, type Reachability, reachabilityDetail } from './lib/qa/sources/jenkins.ts'

const SAY: Record<Reachability, string> = {
  reachable: 'Jenkins is reachable and the credentials work, so the E2E rows will be read',
  'sign-in-redirect': 'Jenkins answered with a sign-in redirect (Azure App Proxy): this machine is outside its network, so the E2E rows keep their published answers',
  unauthorised: 'Jenkins refused the credentials (401 or 403), so the E2E rows keep their published answers',
  'no-credentials': 'JENKINS_USERNAME and JENKINS_PASSWORD are not set, so the E2E rows keep their published answers',
  network: 'Jenkins could not be reached from here, so the E2E rows keep their published answers',
  'not-json': 'Jenkins answered with a web page, not JSON (a sign-in page?), so the E2E rows keep their published answers',
  config: 'JENKINS_URL is not an https URL, so the E2E rows keep their published answers',
  error: 'Jenkins answered with an error, so the E2E rows keep their published answers',
}

const FAILURE: Record<NetworkFailure, string> = {
  timeout: 'the connection timed out (a firewall dropping it?)',
  'no-route': 'there is no route to it (a firewall rejecting it, or no network path)',
  refused: 'the connection was refused',
  reset: 'the connection was reset',
  dns: 'build.hmcts.net did not resolve',
  tls: "the TLS handshake failed (the certificate doesn't match?)",
  other: 'the request failed',
}

const { kind, failure } = await reachabilityDetail()
const line = kind === 'network' && failure ? `${SAY.network}: ${FAILURE[failure]}` : SAY[kind]
console.log(process.env.GITHUB_ACTIONS ? `::notice::${line}` : line)
