// The worker's clipboard. navigator.clipboard wants a focused document, which an
// offscreen one never is, so this is the one place execCommand("copy") still earns a keep.
chrome.runtime.onMessage.addListener((request, _sender, reply) => {
	if (request?.target !== "offscreen" || request.type !== "copy") return
	const clip = document.getElementById("clip")
	clip.value = request.text
	clip.select()
	reply(document.execCommand("copy"))
})
