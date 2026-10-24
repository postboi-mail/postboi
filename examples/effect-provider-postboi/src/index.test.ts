import { expect, test } from "bun:test"
import { Effect } from "effect"
import Mock from "postboi/mock"
import { Mailer } from "postboi/effect"
import "../postboi.config"
import { program } from "./index"

test("welcomes everyone still subscribed", async () => {
	const mock = new Mock()
	const outcomes = await Effect.runPromise(program.pipe(Effect.provide(Mailer.layerMock(mock))))

	expect(outcomes).toEqual(["sent", "unsubscribed: grace@example.com"])
	expect(mock.sent.map((message) => message.to[0].address)).toEqual(["ada@example.com"])
})
