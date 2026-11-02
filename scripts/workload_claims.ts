// Prints the claims of this job's GitHub OIDC token (never the token) for the workload audience.
const id = process.env.POSTBOI_WORKLOAD_ID!
const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL!)
url.searchParams.set("audience", `https://postboi.app/workloads/${id}`)
const answer = await fetch(url, { headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } })
const { value } = (await answer.json()) as { value: string }
const claims = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString())
const keep = ["iss", "aud", "sub", "repository", "repository_id", "repository_owner_id", "ref", "ref_type",
	"event_name", "environment", "workflow_ref", "job_workflow_ref", "job_workflow_sha", "workflow_sha", "head_ref", "base_ref"]
for (const key of keep) console.log(`${key}=${JSON.stringify(claims[key])}`)
console.log(`exp-iat=${claims.exp - claims.iat} nbf-iat=${claims.nbf === undefined ? "none" : claims.nbf - claims.iat}`)
