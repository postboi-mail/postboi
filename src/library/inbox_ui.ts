/**
 * The dev inbox's UI: one self-contained document, no build step, no dependencies. It's
 * dressed as AOL 4.0 on Windows 98 because a local mail client that looks nothing like
 * production mail is a feature — you can never mistake a screenshot of this for the real
 * thing.
 *
 * Window chrome comes from XP.css (vendored in inbox_theme.ts); the AOL furniture on top of
 * it — the coloured toolbar bands, the mailbox header, the folder tabs — is ours, because no
 * OS framework ships those.
 *
 * Each channel opens as its own application on the desktop: mail in the AOL reader,
 * WhatsApp in a WhatsApp-green window, Slack/Discord/Teams/Telegram in a chat window
 * wearing that platform's colours, pushes in a notification shade — all inside the XP
 * frame — and SMS on a handset that has no frame at all, the way Winamp had none.
 * They are children of the desktop the app manages: minimising Postboi Local takes every
 * one of them down with it, and restoring brings back exactly the set that was up.
 */

import { THEME_CSS } from "./inbox_theme.js"
import { FREEDOOM_NOTICE } from "./inbox_poom.js"
import type { Channel } from "./errors.js"

/**
 * Channel chip labels, typed here (and inlined into the client script below) so adding a
 * channel without a label is a compile error rather than a blank chip. Chat is the fallback
 * only: a capture that names its platform is chipped with the platform, not with "Chat".
 */
const CHANNEL_LABELS = {
	email: "Mail",
	sms: "SMS",
	whatsapp: "WhatsApp",
	chat: "Chat",
	push: "Push",
} satisfies Record<Channel, string>

/**
 * The Postboi mark, inlined as a data URI — the tab icon, and the badge in every title
 * bar and on the sign-on. Copied from static/favicon.svg; the published package has no
 * static directory to serve it from.
 */
const FAVICON =
	"data:image/svg+xml,%3Csvg%20width%3D%22664%22%20height%3D%22664%22%20viewBox%3D%22-76%20-76%20664%20664%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%20%3Cpath%20d%3D%22M68.3939%20168.189L68.3751%20168.72C56.7497%20176.365%2028.1454%20195.529%2025.0885%20209.716C21.192%20227.793%2049.1638%20244.048%2064.0193%20248.609C63.4697%20259.384%2063.0556%20277.148%2064.968%20287.805C51.0574%20290.624%2039.5035%20295.187%2031.4207%20307.82C14.5473%20334.193%2022.5963%20369.062%2049.2014%20385.517C56.7911%20390.265%2061.3426%20391.191%2069.768%20393.42C69.768%20444.235%20139.294%20508.235%20239.059%20510.118C338.824%20512%20421.921%20443.237%20431.059%20393.412C502.84%20388.804%20506.628%20299.158%20448.185%20287.251C451.509%20272.03%20452.36%20256.371%20450.696%20240.88C450.018%20234.704%20445.41%20227.947%20447.27%20223.786C455.074%20206.312%20451.95%20180.459%20447.338%20163.343C434.677%20116.336%20406.532%2090.6687%20371.302%2059.6648C356.703%2046.8178%20347.121%2034.0163%20328.976%2024.1441C289.145%202.47405%20245.056%20-1.48981%20201.947%2010.2346C154.414%2023.4762%20114.045%2054.9714%2089.6344%2097.8536C77.3953%20119.356%2069.3652%20143.371%2068.3939%20168.189Z%22%20fill%3D%22%230F1C41%22%2F%3E%20%3Cpath%20d%3D%22M259.765%20350.118C257.882%20363.294%20223.153%20378.787%20212.002%20360.205C209.292%20355.728%20208.558%20350.33%20209.981%20345.293C213.806%20331.236%20228.578%20323.482%20242.677%20325.848C253.933%20327.737%20261.647%20336.941%20259.765%20350.118Z%22%20fill%3D%22%23F88428%22%2F%3E%20%3Cpath%20d%3D%22M382.931%20206.464C384.968%20210.523%20381.768%20230.997%20384.102%20236.757C396.808%20268.104%20407.744%20293.006%20405.467%20328.039C405.29%20330.786%20407.202%20334.861%20409.943%20336.37C427.283%20345.914%20423.692%20308.011%20439.861%20306.756C465.269%20304.06%20475.641%20336.713%20461.681%20354.527C452.695%20366.002%20445.772%20368.185%20432.102%20370.493C429.757%20367.38%20425.228%20359.685%20421.324%20360.34C412.955%20369.443%20408.418%20411.819%20391.096%20429.908C367.996%20454.032%20347.117%20468.88%20315.445%20480.234C268.04%20497.225%20218.327%20500.756%20171.867%20479.057C148.334%20468.854%20124.842%20454.887%20107.713%20435.363C83.8557%20408.536%2086.991%20374.047%2085.9783%20341.249C85.0635%20311.741%2090.2667%20287.11%2092.3787%20258.482C114.026%20255.485%20119.346%20254.017%20139.765%20246.468C138.764%20248.746%20137.8%20251.039%20136.866%20253.346C135.545%20256.685%20135.285%20257.723%20136.588%20260.751L138.308%20261.038C146.124%20257.575%20175.838%20247.787%20178.428%20245.364L178.493%20243.202C177.1%20239.807%20173.666%20237.171%20170.873%20234.618C178.805%20234.647%20184.983%20234.719%20192.862%20233.878L192.592%20247.311C219.935%20247.071%20255.921%20232.44%20278.171%20217.064L271.684%20236.376C295.413%20231.261%20319.691%20227.567%20342.942%20221.005C355.833%20217.366%20369.021%20211.486%20381.403%20206.187L382.931%20206.464ZM301.832%20376.713C278.547%20394.038%20260.413%20404.775%20229.655%20400.242C217.559%20398.45%20206.039%20393.884%20195.995%20386.9C191.884%20384.005%20186.899%20378.215%20182.043%20378.475C175.609%20387.615%20190.642%20423.64%20195.562%20433.259C204.925%20447.941%20217.872%20460.85%20235.494%20464.675C277.218%20473.729%20299.226%20429.799%20305.254%20395.759C306.413%20389.201%20309.237%20379.804%20301.832%20376.713ZM271.609%20339.789C255.786%20289.622%20182.792%20315.676%20194.737%20361.579C202.557%20391.614%20282.353%20384%20271.609%20339.789ZM323.471%20280.553C315.983%20284.478%20311.809%20289.404%20309.663%20297.735C305.522%20313.818%20312.155%20350.775%20325.489%20350.446C338.823%20350.117%20346.372%20284.804%20323.471%20280.553ZM158.178%20280.733C132.861%20291.75%20139.11%20347.683%20158.893%20349.246C166.103%20346.02%20170.896%20341.404%20173.196%20333.701C178.361%20316.409%20180.074%20286.409%20158.178%20280.733ZM343.688%20262.393C352.9%20256.917%20336.038%20232.49%20314.049%20233.772C306.278%20238.797%20306.041%20242.327%20303.594%20251.289C321.728%20251.403%20325.162%20250.91%20340.149%20261.352L343.688%20262.393Z%22%20fill%3D%22%23FCC58F%22%2F%3E%20%3Cpath%20d%3D%22M232.975%20437.332C246.822%20435.984%20255.835%20437.479%20269.026%20441.236C264.588%20446.375%20263.473%20447.708%20258.026%20451.841C251.005%20453.999%20223.436%20453.942%20226.199%20442.17C228.364%20439.211%20229.73%20438.827%20232.975%20437.332Z%22%20fill%3D%22%23E04A6E%22%2F%3E%20%3Cpath%20d%3D%22M119.36%20355.277C126.82%20353.057%20133.485%20354.181%20140.405%20357.536C152.798%20363.54%20146.245%20376.615%20137.412%20378.353C129.95%20379.821%20122.561%20380.55%20116.706%20376.471C109.993%20371.793%20106.075%20359.23%20119.36%20355.277Z%22%20fill%3D%22%23F88428%22%2F%3E%20%3Cpath%20d%3D%22M355.765%20353.882C370.824%20353.882%20383.075%20379.154%20360.949%20378.753C338.824%20378.353%20332.853%20368.342%20334.897%20362.994C336.941%20357.647%20340.706%20353.882%20355.765%20353.882Z%22%20fill%3D%22%23F88428%22%2F%3E%20%3Cpath%20d%3D%22M89.0997%20152.275C98.6357%20121.566%20105.695%20102.135%20127.311%2077.2893C154.094%2046.5083%20197.561%2025.1854%20238.246%2022.7786C264.294%2021.2377%20299.118%2029.1564%20321.777%2042.6563C329.051%2046.9891%20338.056%2055.2078%20344.584%2060.9855C344.426%2062.0784%20344.223%2063.4853%20343.978%2065.2057C348.029%2076.4035%20353.657%2086.7079%20356.778%2098.2858C360.057%20110.451%20360.328%20123.204%20358.961%20135.672C358.517%20139.733%20357.113%20146.317%20353.578%20148.8C331.931%20137.956%20297.043%20123.309%20272.93%20123.096C281.529%20114.918%20288.166%20107.384%20289.22%2095.0328C290.459%2081.9801%20286.348%2068.984%20277.828%2059.0173C257.781%2035.2842%20227.957%2036.8142%20205.753%2055.4115C186.858%2071.2406%20187.2%20102.518%20203.453%20120.116C178.741%20121.775%20151.752%20127.447%20128.742%20136.741C117.644%20141.225%2099.9346%20149.561%2089.0997%20152.275Z%22%20fill%3D%22%238DB7D5%22%2F%3E%20%3Cpath%20d%3D%22M215.963%20135.277C268.149%20129.918%20349.802%20155.829%20387.686%20191.482C373.324%20188.181%20357.237%20186.536%20342.382%20183.3C310.442%20176.343%20274.124%20167.503%20241.713%20164.129C233.435%20162.617%20219.087%20162.461%20210.549%20162.202C158.645%20160.621%20113.905%20173.945%2065.7472%20191.06C113.811%20154.615%20155.219%20139.779%20215.963%20135.277Z%22%20fill%3D%22%23346696%22%2F%3E%20%3Cpath%20d%3D%22M344.584%2060.9855C382.532%2093.6552%20427.272%20132.896%20431.5%20186.19C431.921%20191.535%20433.284%20205.359%20430.295%20209.175C418.843%20203.351%20401.047%20176.297%20385.525%20168.839C384.825%20168.504%20352.592%20147.761%20353.578%20148.8C357.113%20146.317%20358.517%20139.733%20358.961%20135.672C360.328%20123.204%20360.057%20110.451%20356.778%2098.2858C353.657%2086.7078%20338.824%2065.8823%20344.584%2060.9855Z%22%20fill%3D%22%23588CB5%22%2F%3E%20%3Cpath%20d%3D%22M67.7048%20306.415C70.2159%20309.199%2069.7152%20364.109%2069.8093%20370.599C62.6451%20368.363%2059.2794%20366.251%2053.2258%20362.095C36.4653%20347.559%2037.5006%20322.281%2056.5726%20310.116C59.5768%20308.201%2064.2338%20307.25%2067.7048%20306.415Z%22%20fill%3D%22%23FCC58F%22%2F%3E%20%3Cpath%20d%3D%22M218.353%2065.8824C218.353%2065.8824%20244.706%2037.6471%20272.746%2067.4902L242.824%2080.9412L218.353%2065.8824Z%22%20fill%3D%22%23FEFDFD%22%2F%3E%20%3Cpath%20d%3D%22M242.824%2094.1176L264.607%20111.245C242.824%20128%20214.588%20111.245%20214.588%20111.245L242.824%2094.1176Z%22%20fill%3D%22%23FDC005%22%2F%3E%20%3Cpath%20d%3D%22M252.235%2088.4706L276.706%2077.1765C276.706%2077.1765%20286.118%2092.2353%20272.941%20103.529L252.235%2088.4706Z%22%20fill%3D%22%23FEFDFD%22%2F%3E%20%3Cpath%20d%3D%22M208.941%20101.647C208.941%20101.647%20201.412%2086.5882%20211.283%2074.8412L233.412%2088.4706L208.941%20101.647Z%22%20fill%3D%22%23FEFDFD%22%2F%3E%20%3C%2Fsvg%3E"

/*
 * POOM's desktop icon: the wordmark, in the shape the 1993 one had — splayed heavy letters,
 * hot metal running from white at the top through orange to a dark red at the feet, a black
 * outline thick enough to survive being 48px wide, and a scorched tile behind it.
 *
 * Drawn rather than lifted: the original is a licensed logo in a typeface nobody may ship.
 * `textLength` pins the width so a machine without Impact still gets letters that fit.
 */
const POOM_ICON =
	"data:image/svg+xml," +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 60" width="64" height="60">' +
			"<defs>" +
			'<linearGradient id="m" x1="0" y1="0" x2="0" y2="1">' +
			'<stop offset="0" stop-color="#fff3c4"/><stop offset=".26" stop-color="#ffb02a"/>' +
			'<stop offset=".58" stop-color="#d8300f"/><stop offset="1" stop-color="#4c0703"/>' +
			"</linearGradient>" +
			'<radialGradient id="b" cx=".5" cy=".42" r=".72">' +
			'<stop offset="0" stop-color="#5a1108"/><stop offset="1" stop-color="#160705"/>' +
			"</radialGradient>" +
			"</defs>" +
			'<rect x="2" y="4" width="60" height="52" rx="5" fill="url(#b)" stroke="#0b0402" stroke-width="3"/>' +
			'<rect x="5" y="7" width="54" height="46" rx="3" fill="none" stroke="#8a2a12" stroke-width="1"/>' +
			'<g transform="translate(32 34) scale(1 1.42)">' +
			'<text text-anchor="middle" y="7" textLength="50" lengthAdjust="spacingAndGlyphs" ' +
			'font-family="Impact, Haettenschweiler, \'Arial Narrow\', sans-serif" font-size="26" ' +
			'paint-order="stroke" stroke="#120302" stroke-width="5" stroke-linejoin="round" ' +
			'fill="url(#m)">POOM</text>' +
			"</g>" +
			"</svg>"
	)

const CSS = `
* { box-sizing: border-box }

/*
 * Windows XP's own arrow, everywhere. Native apps don't switch to a hand over buttons —
 * that's a web convention — so nothing here uses the hand. The arrow-and-hourglass takes
 * over while the sign-on is connecting, which is what XP showed for "working, but you can
 * still click".
 */
#screen, #screen * { cursor: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAj0lEQVR4nO2WQQqAMAwEN8H/fzkebKU2tQrazSUDYlsPOyw0CACGQLS8wyQUAMwsTKI2ECah7SZCQvsDtoQTYEsMBZgStwIsiakAQ+JRYLXENvsoIs4FgDv8gmtgECrd8ysXgUH4ck6BEi7H8hCh3YImnE5toA+ntaCDcCqzOUBp4dUgisYQ/N+YJEmSLGUHGtQ1GJ7uSPQAAAAASUVORK5CYII=") 0 0, default }
.connecting #screen, .connecting #screen * { cursor: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA2UlEQVR4nO2WyRLEIAhEu6fy/7/MHLIUGpcmccaLXZVLRHhBhACAYaLoACjuUYElfxsAmBlIWgACZmUOUnax2+++zG/ueRiagQQgAtHJgJyGT8Ez8MfCvAE8gYieexdAgTiDkkRWQ2MAOhBsBA9RNAFUiPzdUIAGhLm15F1Et2uYLJbP9Oqe+b4nx3DLQCEoswc+uLevfYgMEG6jRxEOuYaug/F02LqKPvgbiNo0bM2H8bOgYlyDKBbg5TBYiJtq2Aj0SvLUi045VVIjmi3D5P/GpaWlpaWf6guIkmosdmuLBwAAAABJRU5ErkJggg==") 0 0, progress }
/*
 * Nothing in a system UI selects. Dragging across a menu, a title bar or a list in Windows
 * moves and picks things; it never leaves a blue smear of highlighted label text. The places
 * where selecting *is* the point say so for themselves, below.
 */
#screen, #screen * { -webkit-user-select: none; user-select: none }
/*
 * Text you are meant to be able to take: the message body, its headers, and the raw views.
 * The beam matches the arrow above — the native one is close, but not the same drawing, and
 * the two swapping back and forth as you cross the pane is exactly what gives it away.
 */
/* Qualified by #screen, or the blanket rule above outranks it and nothing selects at all. */
#screen .selectable, #screen .selectable * {
	-webkit-user-select: text; user-select: text;
	cursor: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZUlEQVR4nO2WsQ7AIAgFpfH/f/l1sQuLvMbawbvJKCEnmEhrcDpRDZQkK3FEKXc3k5biHNfLEfgCqwL5Zk9FzO6sYbwJjeVrg99bgAACCCCAAAIIlAeS2Z+fz7fOhHn/nJkQYAU3Z9MlJ47DlFIAAAAASUVORK5CYII=") 15 15, text;
}

/* The set has no resize cursors, so the native ones stand in on the handles. */
.grip { cursor: nwse-resize }
.edge-r { cursor: ew-resize }
.edge-b { cursor: ns-resize }
/* The machine sits inset on black, the way a screenshot of one does. */
body {
	margin: 0; padding: 16px; height: 100vh; overflow: hidden; box-sizing: border-box;
	background: #0a0b0c;
	font: 12px "MS Sans Serif", Tahoma, Geneva, Verdana, sans-serif;
	color: #000;
	-webkit-font-smoothing: none;
}
button { font: 12px "MS Sans Serif", Tahoma, Geneva, Verdana, sans-serif }

/*
 * XP.css sizes every button for a dialog — 75x23 minimum. The AOL furniture is full of
 * things that aren't dialog buttons (icon tiles, nav arrows, folder tabs), so they opt out.
 */
/*
 * XP.css sizes every button for a dialog and gives it an amber hover bevel. Both are right
 * for a dialog button and wrong for everything here that isn't one — a toolbar tile, a folder
 * tab, a taskbar button — which draw their own edges and were picking up a yellow ring on
 * hover that the real UI never had.
 */
#toolbar button, #folders button, #tabs button, #taskbar button, .aolbtn, .grip {
	min-width: 0; min-height: 0; box-sizing: border-box;
}
/* Matched to XP.css's own not-disabled hover rule, which outranks a bare class selector. */
#folders button:hover, #tabs button:hover,
.aolbtn:not(:disabled):hover, .grip:not(:disabled):hover { box-shadow: none }
/* XP.css supplies the bevels; these are the two insets it does not name. */
.sunken { box-shadow: inset -1px -1px #fff, inset 1px 1px grey, inset -2px -2px #dfdfdf, inset 2px 2px #0a0a0a }
.thin-sunken { border: 1px solid; border-color: #808080 #fff #fff #808080 }
/*
 * XP.css draws the window's 3px blue frame as inset shadows *over* the content box, which
 * is why its own padding is "0 0 3px" — no top, no sides. Adding padding there pushes the
 * title bar inward and lets the silver window background show in the gap, worst at the
 * rounded top corners. Sides are padded here instead and the title bar spans back out over
 * them, so it stays full-bleed under the frame the way the real one is.
 */
.window { padding: 0 3px 3px; display: flex; flex-direction: column; min-height: 0 }
/*
 * Left to XP.css. Its caption buttons are 21px pixel-art tiles that carry their own blue
 * edging, drawn for the 21px bar it sets — override the height and the sprite stops
 * lining up with the gradient, which shows as a grey seam behind the controls.
 */
.title-bar { flex: none; margin: 0 -3px }
/*
 * An unfocused window in XP doesn't go grey — it goes pale. Same blue, washed out, with the
 * caption text and the buttons faded back with it, so the stack still reads as one family of
 * windows rather than one live one and a pile of dead ones.
 */
.title-bar.dim {
	background: linear-gradient(180deg, #85b3f5 0%, #7aa9f0 8%, #6f9eea 40%, #7fabf2 88%, #6e9ce8 100%);
}
.title-bar.dim .title-bar-text { opacity: .72 }
.title-bar.dim .title-bar-controls button { opacity: .55 }
.title-bar.dim .title-bar-controls button:hover { opacity: 1 }

/*
 * The desktop. The drawn gradient sits underneath the wallpaper still as the fallback: it is
 * what you see if the image hasn't loaded, and the two are close enough that the swap doesn't
 * read as a flash.
 */
#screen {
	position: relative; height: 100%; overflow: hidden; border-radius: 7px;
	background:
		radial-gradient(120% 70% at 50% 118%, #6aa83c 0%, #4f8f2c 38%, #3f7d24 55%, rgba(63,125,36,0) 56%),
		radial-gradient(90% 40% at 18% 104%, #86bf4e 0%, rgba(134,191,78,0) 60%),
		linear-gradient(180deg, #1f5fb0 0%, #3f8fd8 42%, #86bde8 72%, #cfe4f2 88%, #eaf3f8 100%);
}
/* The photograph itself is layered on from script, which is the only place the mount path is
   known — the UI is served from wherever it's mounted, not a fixed URL. */
#screen.papered { background-size: cover; background-position: center }
/*
 * The clip. It sits above the wallpaper and below everything else, so minimising reveals it.
 *
 * Sized explicitly: a replaced element given only insets still lays out at its intrinsic size,
 * so it would sit at its own width in the corner rather than filling the desktop.
 */
#bliss {
	position: absolute; left: 0; top: 0; width: 100%; height: calc(100% - 30px);
	object-fit: cover; z-index: 0; display: none;
}
#bliss.showing { display: block }
/* Everything the app is, so it can be hidden to reveal the desktop. */
#aol { position: absolute; left: 0; top: 0; right: 0; bottom: 30px; z-index: 10 }
#aol.min, #aol.closed { display: none }

/*
 * The shortcut on the desktop, which is how you get the app back once you've closed it.
 * Below every window and above the wallpaper, and draggable, because an icon you can't move
 * is a picture of an icon.
 */
#icons { position: absolute; left: 0; top: 0; right: 0; bottom: 30px; z-index: 1 }
.shortcut {
	position: absolute; width: 82px; padding: 4px; border: 0; background: none;
	display: flex; flex-direction: column; align-items: center; gap: 3px;
	font: 11px Tahoma, Arial, sans-serif; color: #fff; text-align: center; line-height: 1.25;
}
.shortcut img { width: 48px; height: 45px; filter: drop-shadow(1px 2px 2px rgba(0,0,0,.5)) }
/* XP's label: a soft shadow unselected, the selection blue behind it when picked. */
.shortcut span { padding: 1px 3px; text-shadow: 0 1px 2px rgba(0,0,0,.9), 0 0 3px rgba(0,0,0,.7) }
.shortcut.on img { filter: drop-shadow(1px 2px 2px rgba(0,0,0,.5)) brightness(.82) saturate(1.3) }
.shortcut.on span { background: #0b61ff; text-shadow: none }

/* ---- Title bars, shared by the app window and every child window ---- */
.title-bar-text { display: flex; align-items: center; gap: 5px; margin-right: 12px }

/* ---- The AOL application window ---- */
#aol { display: flex; flex-direction: column; min-height: 0; background: #c0c0c0 }
#menubar { display: flex; gap: 2px; padding: 1px 4px; background: #c0c0c0 }
#menubar { position: relative }
#menubar > span { padding: 2px 7px }
#menubar > span.on { background: #316ac5; color: #fff }
.menu-pop { display: none; position: absolute; top: 100%; z-index: 400; min-width: 170px; background: #fff;
	border: 1px solid #808080; box-shadow: 2px 2px 3px rgba(0,0,0,.35); padding: 2px }
.menu-pop.open { display: block }
.menu-pop li { list-style: none; padding: 4px 20px 4px 10px }
.menu-pop li:hover { background: #316ac5; color: #fff }
.menu-pop li.sep { padding: 0; margin: 3px 2px; height: 1px; background: #c0c0c0 }
.menu-pop li.sep:hover { background: #c0c0c0 }
.menu-pop ul { margin: 0; padding: 0 }
#menubar u { text-decoration: underline }

/* The toolbar: chunky icon-over-label buttons in coloured bands, AOL's signature. */
#toolbar { display: flex; align-items: stretch; background: #c0c0c0; border-top: 1px solid #dfdfdf; border-bottom: 2px solid #808080 }
.band { display: flex; align-items: stretch; padding: 3px 2px; gap: 1px; border-right: 1px solid #808080 }
.band.b1 { background: #b8c4dc }
.band.b2 { background: #86c0c0 }
.band.b5 { flex: 1; background: linear-gradient(90deg, #2a4a8a, #14284f); justify-content: flex-end; align-items: center; padding-right: 10px; border-right: 0 }
.tb {
	display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 1px;
	min-width: 58px; padding: 3px 5px 2px; background: transparent; 
	font: 11px "MS Sans Serif", Tahoma, sans-serif; border: 2px solid transparent;
}
.tb:hover { border-color: #fff #808080 #808080 #fff }
.tb:active { border-color: #808080 #fff #fff #808080; padding: 4px 4px 1px 6px }
.tb .ico { font-size: 17px; line-height: 18px }
.tb.on { border-color: #808080 #fff #fff #808080; background: rgba(255,255,255,.35) }


/* The MDI workspace child windows float in. */
/* The app's empty interior. The mail windows used to live in here; they are the desktop's
   now, so what is left is the grey an MDI app shows when nothing is open inside it. */
#workspace { flex: 1; background: #6a6a6a; min-height: 0 }
.child { display: flex; flex-direction: column; background: #c0c0c0; min-height: 0 }
/*
 * Real MDI child windows: dragged by the title bar, resized from the edges, maximised,
 * minimised to the taskbar, raised on click. Floating over each other the way AOL did is
 * only tolerable once you can actually move them — which is also what lets the reader be
 * as big as the mail needs.
 */
.child { position: absolute }
/* "#reader.open" sets display:flex and outranks a bare ".child.min" on specificity, so
   minimising has to be spelled out at least as strongly or the window never hides. */
.child.min, .child.closed, #reader.open.min, #reader.open.closed { display: none }
.child .title-bar {  user-select: none }
.child.max .grip, .child.max .edge { display: none }
/* Maximised, the app fills the desktop and there is no edge to take hold of. */
#aol.maxed .grip, #aol.maxed .edge { display: none }
.grip { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; z-index: 6 }
/* The Win95 hatch: three stepped highlights, drawn with a repeating gradient. */
.grip::after {
	content: ""; position: absolute; inset: 3px;
	background: repeating-linear-gradient(135deg, #fff 0 2px, #808080 2px 4px, transparent 4px 6px);
}
.edge { position: absolute; z-index: 5 }
.edge-r { top: 0; bottom: 0; right: -2px; width: 6px; cursor: ew-resize }
.edge-b { left: 0; right: 0; bottom: -2px; height: 6px; cursor: ns-resize }
/* An iframe eats mousemove, so a drag that crosses one would stall halfway. */
.dragging iframe { pointer-events: none }

/* Mailbox header: the wordmark. */
#mbhead { display: flex; align-items: center; gap: 12px; padding: 7px 10px; background: #fff }
#mbhead .mark { display: flex; align-items: center; gap: 8px; color: #000080 }
#mbhead .mark span { font: italic bold 21px Georgia, "Times New Roman", serif; letter-spacing: -.5px }
/* The one thing everybody remembers. */
@keyframes wave { 0%, 100% { transform: rotate(0) } 50% { transform: rotate(-11deg) } }
/* Only the flag waves — a wobbling mailbox reads as a rendering bug, not as delight. */
#mbhead .flag { animation: wave 1.5s ease-in-out infinite; transform-box: view-box; transform-origin: 28px 30px }

/*
 * The folder tabs. Outbox rather than New Mail, because that is what these are — messages
 * on their way out, caught. Scheduled is the ones that were never going out today: without
 * it a mail queued for next Tuesday sits in the list looking exactly like one already gone.
 */
#folders { display: flex; gap: 3px; padding: 4px 10px 0; background: #003399 }
#folders button {
	padding: 5px 16px 6px;  background: #7f9fcf; color: #eaeef8; font-weight: bold;
	border: 0; border-radius: 7px 7px 0 0;
}
#folders button.on { background: #fff; color: #003399 }
#listwrap { padding: 0 10px 6px; background: #003399; flex: 1; min-height: 0; display: flex }
#list { flex: 1; background: #fff; overflow: auto; min-height: 0 }

table { width: 100%; border-collapse: collapse; font: 12px "MS Sans Serif", Tahoma, sans-serif }
tbody td { padding: 2px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
tbody tr {  }
tbody tr.unread td { font-weight: bold }
tbody tr.on td { background: #000080; color: #fff }
td.flag { width: 26px; text-align: center }
.mailico { width: 16px; height: 13px; vertical-align: -2px }
/* The when, stated in the row itself — a scheduled message should not need opening to spot. */
.sched { color: #8a5a00; font-weight: normal; font-style: italic }
.sched.off { color: #8a2a2a }
tr.on .sched { color: #ffd98a }
tr.on .sched.off { color: #ffb3b3 }
#head .schedbar {
	margin: 6px 0 0; padding: 4px 8px; background: #fff4d0; border: 1px solid #d8ae4a;
	color: #6b4a00;
}
#head .schedbar.off { background: #fbe3e3; border-color: #d08a8a; color: #7a2020 }
td.when { width: 88px }
td.who { width: 30% }
td.chanco { width: 78px }
#empty { padding: 26px; text-align: center; color: #808080; line-height: 1.6 }

/* The action row along the bottom of the mailbox window. */
#actions { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #c0c0c0 }
#actions .spacer { flex: 1 }
.aolbtn {
	min-width: 92px; padding: 4px 14px;  background: #b6c6de; color: #000080; font-weight: bold;
	border: 2px solid; border-color: #fff #6a7a94 #6a7a94 #fff;
}
.aolbtn:active { border-color: #6a7a94 #fff #fff #6a7a94 }
.aolbtn[disabled] { color: #808080;  }

/* The reader opens as its own child window, the way AOL opened mail. */
#reader { display: none }
#reader.open { display: flex }
#head { padding: 7px 9px; background: #c0c0c0; border-bottom: 1px solid #808080 }
#head .subject { font-weight: bold; font-size: 13px; margin-bottom: 3px }
#head dl { display: grid; grid-template-columns: max-content 1fr; gap: 1px 8px; margin: 0 }
#head dt { color: #000080; font-weight: bold }
#head dd { margin: 0; overflow: hidden; text-overflow: ellipsis }
#tabs { display: flex; gap: 3px; padding: 5px 8px 0; background: #c0c0c0 }
#tabs button { padding: 4px 13px;  background: #7f9fcf; color: #eaeef8; font-weight: bold; border: 0; border-radius: 7px 7px 0 0 }
#tabs button.on { background: #fff; color: #003399 }
#pane { flex: 1; margin: 0 8px 8px; background: #fff; min-height: 0; overflow: auto }
#pane iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff }
#pane pre { margin: 0; padding: 10px; font: 12px ui-monospace, "Courier New", monospace; white-space: pre-wrap; word-wrap: break-word }
#pane .files { padding: 10px }
#pane .files a { display: block; margin-bottom: 5px; color: #0000ee }
/* The system message box: an icon, a sentence, a row of keys. Sized to its text the way
   a real one is, and never resizable — there is nothing in it to make bigger. */
#alertwin { width: 400px; height: auto }
#alertwin .dlgbody { background: #d4d0c8; padding: 14px 14px 10px }
#alertwin .dlgrow { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px }
#alertwin .dlgicon {
	flex: none; width: 32px; height: 32px; border-radius: 50%;
	background: #f5c518; color: #000; font: bold 22px/32px Georgia, serif;
	text-align: center; border: 1px solid #a07d00;
}
#alertwin #alert-text { font-size: 11px; line-height: 1.45; padding-top: 3px }
#alertwin .dlgbtns { display: flex; justify-content: flex-end; gap: 6px }
#alertwin .dlgbtns button { min-width: 88px }

/* The capture viewer. The image sits inset on the workspace grey a picture viewer of the
   era would have used, and the whole capture is shown — these are tall scrolling renders,
   so the stage scrolls rather than shrinking the thing you opened it to read. */
#shotbody { display: flex; flex-direction: column; height: 100%; background: #d4d0c8 }
#shotbody .shot-stage {
	flex: 1; overflow: auto; margin: 3px; padding: 6px;
	background: #808080; border: 1px solid #808080;
	border-top-color: #404040; border-left-color: #404040;
	border-right-color: #fff; border-bottom-color: #fff;
}
#shotbody .shot-stage img { display: block; margin: 0 auto; background: #fff; max-width: 100% }
#shotbody .shot-foot {
	flex: none; display: flex; align-items: center; justify-content: space-between;
	gap: 6px; padding: 4px 6px 6px; font-size: 11px;
}
#shotbody .shot-nav { min-width: 74px }
#shotbody .shot-nav[disabled] { color: #808080 }

/* The Report tab: postboi/inspect's findings, set like a system dialog would set them. */
#pane .report { padding: 10px 12px; font: 12px "MS Sans Serif", Tahoma, sans-serif }
#pane .report .r-status { font-weight: bold; margin-bottom: 8px }
#pane .report .r-status.pass { color: #006600 }
#pane .report .r-status.error { color: #aa0000 }
#pane .report ul { margin: 0; padding: 0; list-style: none }
#pane .report li { margin-bottom: 7px; line-height: 1.45 }
#pane .report .r-mark { display: inline-block; width: 14px; font-weight: bold }
#pane .report li.error .r-mark { color: #aa0000 }
#pane .report li.warning .r-mark { color: #7a5200 }
#pane .report li.info .r-mark { color: #808080 }
#pane .report .r-clients { color: #808080; margin-left: 14px }
#pane .report .r-size { color: #808080; margin-top: 9px }
#pane .report .r-shead { font-weight: bold; border-top: 1px solid #c0c0c0; margin-top: 12px; padding-top: 10px }
#pane .report .r-snote { color: #808080; margin-top: 5px }
#pane .report .r-sgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin-top: 7px }
#pane .report .r-shot { margin: 0; border: 1px solid #808080; background: #fff; padding: 3px }
#pane .report .r-shot img { display: block; width: 100%; height: 110px; object-fit: cover; object-position: top }
#pane .report .r-shot .r-hold { height: 110px; display: flex; align-items: center; justify-content: center; color: #808080; background: #efefef; font-size: 11px }
#pane .report .r-shot figcaption { padding: 3px 2px 1px; font-size: 10px; color: #404040; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
#blank { display: flex; height: 100%; align-items: center; justify-content: center; color: #808080; text-align: center; line-height: 1.7 }
#readerfoot { display: flex; align-items: center; gap: 10px; padding: 0 10px 10px; background: #c0c0c0 }
#readerfoot #r-count { flex: 1; text-align: center; font-weight: bold; color: #17265c }

/* ---- Channel chips in the mailbox list ---- */
/*
 * Their own column, not a tail on the subject: which channel a capture went out on is the
 * thing you scan the list for, and a chip that moves left and right with the length of the
 * subject in front of it can't be scanned at all.
 */
.chan {
	display: inline-block; font: bold 9px Tahoma, Arial, sans-serif; letter-spacing: .02em;
	color: #0b5394; background: #dceafa; border: 1px solid #9db9d9; border-radius: 3px;
	padding: 0 4px; vertical-align: 1px; text-transform: uppercase;
}
/* Each platform in its own colours — the same cue as the window it opens into. */
.chan.c-slack { color: #4a154b; background: #f2e6f3; border-color: #c9a9cc }
.chan.c-discord { color: #3b45b5; background: #e6e8fb; border-color: #a8afe9 }
.chan.c-teams { color: #464775; background: #e7e8f2; border-color: #adb0d0 }
.chan.c-telegram { color: #16789f; background: #dff2fb; border-color: #93cde5 }
.chan.c-bluesky { color: #0b62c4; background: #dfeeff; border-color: #9cc4ee }
.chan.c-whatsapp { color: #0b7a49; background: #ddf5e8; border-color: #90cfae }
.chan.c-push { color: #8a5a00; background: #fdf0d2; border-color: #dcbc73 }
/* Selected, the row is solid navy: every chip goes to the same reversed pair or vanishes. */
tr.on .chan { background: #2f5db3; color: #fff; border-color: #7aa0dc }

/*
 * ---- The Messenger window ----
 *
 * The fallback conversation window: a chat whose platform the capture doesn't name opens
 * here. (Slack, Discord, Teams and Telegram get their own skins; WhatsApp, push and SMS
 * their own windows entirely.) It is dressed as MSN Messenger with the same shamelessness
 * the rest of this wears AOL: the To: banner, the display-picture boxes down the right,
 * the toolbar of things that never worked, and the nudge.
 */
#messenger { display: none }
#messenger.open { display: flex }
#messenger.open.min, #messenger.open.closed { display: none }
#msnbar {
	display: flex; gap: 1px; padding: 3px 6px 2px;
	background: linear-gradient(180deg, #fdfefe 0%, #e8f1fb 45%, #d2e3f6 100%);
	border-bottom: 1px solid #a9c4e2;
}
#msnbar button {
	display: flex; flex-direction: column; align-items: center; min-width: 52px;
	padding: 2px 6px 1px; background: transparent; border: 1px solid transparent;
	border-radius: 3px; font: 10px Tahoma, Arial, sans-serif; color: #30517c; box-shadow: none;
}
#msnbar button:hover { border-color: #90b4dc; background: rgba(255,255,255,.7); box-shadow: none }
#msnbar .ico { font-size: 15px; line-height: 17px }
#msnto {
	padding: 4px 9px; background: #eef5fd; border-bottom: 1px solid #b7cbe4;
	font: 11px Tahoma, Arial, sans-serif; color: #40506a;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#msnmain {
	flex: 1; display: flex; gap: 7px; padding: 7px; min-height: 0;
	background: linear-gradient(180deg, #cfe1f6 0%, #e8f1fb 34%, #e8f1fb 100%);
}
#msncol { flex: 1; display: flex; flex-direction: column; min-width: 0; gap: 7px }
#msnhistory {
	flex: 1; background: #fff; overflow: auto; padding: 7px 9px;
	font: 12px Tahoma, Arial, sans-serif; border: 1px solid #a9c4e2;
}
#msnhistory .says { color: #6a7686; margin: 7px 0 1px }
#msnhistory .says:first-of-type { margin-top: 2px }
#msnhistory .says b { color: #16233b }
#msnhistory .stamp { color: #a4b0bf; font-size: 10px }
#msnhistory .line { padding-left: 13px; color: #101010; white-space: pre-wrap; word-wrap: break-word }
#msnhistory .line b { color: #24344f }
#msnhistory .sysline { color: #8b96a5; font-size: 11px; margin: 6px 0; font-style: italic }
#msnhistory .tpl {
	background: #f3f7e8; border: 1px dashed #a9c48a; border-radius: 3px;
	padding: 3px 7px; margin: 2px 0 2px 13px; display: inline-block; color: #4a6018;
}
#msnentry { background: #fff; border: 1px solid #a9c4e2; padding: 4px; flex: none }
#msnentry textarea {
	display: block; width: 100%; border: 0; outline: 0; resize: none;
	font: 12px Tahoma, Arial, sans-serif; background: transparent;
}
#msnentry .row { display: flex; justify-content: space-between; align-items: center; margin-top: 3px }
#msnentry .hint { color: #a4b0bf; font-size: 10px; font-style: italic }
#msnentry .btns { display: flex; gap: 4px }
#msnpics { width: 106px; flex: none; display: flex; flex-direction: column; justify-content: space-between }
#msnpics .pic {
	width: 106px; height: 106px; background: #fff; border: 1px solid #90b4dc;
	border-radius: 4px; padding: 6px; box-sizing: border-box;
}
#msnpics .pic img { width: 100%; height: 100%; object-fit: contain }
@keyframes msn-nudge {
	0%, 100% { translate: 0 0 } 10% { translate: -6px 2px } 20% { translate: 5px -3px }
	30% { translate: -4px -2px } 40% { translate: 6px 3px } 50% { translate: -5px 1px }
	60% { translate: 4px -2px } 70% { translate: -3px 3px } 80% { translate: 5px -1px }
	90% { translate: -2px 2px }
}
#messenger.nudging { animation: msn-nudge .55s linear }
@media (prefers-reduced-motion: reduce) { #messenger.nudging { animation: none } }

/* ---- Taskbar and Start menu ---- */
/* The taskbar is Luna's, not 98's — everything else moved to XP.css and this was the last
   thing still wearing grey. */
#taskbar {
	/* No padding: Start sits hard against the left edge and the tray against the right, the
	   way they do on a real taskbar. The gaps between the window buttons are their own. */
	display: flex; align-items: stretch; padding: 0; margin: 0;
	/* Always on top, and windows can't be dragged under it — same as the real one. */
	position: absolute; left: 0; right: 0; bottom: 0; z-index: 500; height: 30px;
	background: linear-gradient(180deg, #3f8cf3 0%, #245edb 9%, #245edb 88%, #1941a5 100%);
	border-top: 1px solid #6ba4f8; color: #fff;
}
.title-bar-text .mark, #taskbar .mark { width: 14px; height: 14px; flex: none; vertical-align: -3px; margin-right: 4px }
/*
 * The real thing, as a three-state sprite: default, hover, pressed, stacked 30px apart. The
 * text and the flag are baked into the bitmap, so the button carries its label only for
 * screen readers.
 */
#start {
	width: 97px; height: 30px; flex: none; border: 0; padding: 0; margin: 0 4px 0 0;
	background: 0 0 no-repeat;
	/* XP.css gives every button an amber hover bevel. That belongs to dialog buttons; the
	   Start button is a bitmap and wears its own states, so the ring is cleared in all of
	   them or it shows as a yellow outline the real thing never had. */
	box-shadow: none;
}
#start:hover, #start:active, #start:focus, #start.on { box-shadow: none }
#start:hover { background-position: 0 -30px }
#start.on { background-position: 0 -60px }
/* XP's Start button never draws a focus rectangle — the pressed sprite is the whole affordance. */
#start:focus, #start:focus-visible { outline: 0 }
#start span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%) }
#taskbar .task {
	flex: 0 0 162px; display: flex; align-items: center; text-align: left; padding: 3px 8px;
	margin: 3px 4px 3px 0;
	overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
	font: 11px Tahoma, Arial, sans-serif; color: #fff;
	background: linear-gradient(180deg, #4993f1 0%, #3c83e3 50%, #2f74d6 100%);
	border: 0; border-radius: 3px; box-shadow: inset 1px 1px 0 rgba(255,255,255,.25);
}
/* Pressed in marks the focused window, as it did on the real thing. */
#taskbar .task.on { background: linear-gradient(180deg, #1e50b0 0%, #2a62c8 60%, #3f7ddd 100%); box-shadow: inset 1px 1px 3px rgba(0,0,0,.45) }
#taskbar #tasks { display: flex; align-items: stretch; min-width: 0 }
#taskbar .spacer { flex: 1 }
/*
 * The tray. It is a band the full height of the taskbar, flush to the right edge, with its
 * own lighter blue and a bevelled left edge — not a floating pill with the bar showing past
 * it on three sides.
 */
#tray {
	display: flex; align-items: center; flex: none;
	background: linear-gradient(180deg, #18a3dc 0%, #14a5e0 8%, #1290d6 90%, #0d7ec4 100%);
	box-shadow: inset 1px 0 0 #4fc6f5, inset 2px 0 0 rgba(0,0,0,.12);
	color: #fff; font: 11px Tahoma, Arial, sans-serif;
}
#clock, #stat, #count { padding: 0 9px; color: #fff; font: 11px Tahoma, Arial, sans-serif }
#clock { padding-right: 12px }

/*
 * The XP Start menu: a blue header with your face in it, two columns of shortcuts, and a
 * footer of the two things that end a session. The 98-era one this replaces was a grey strip
 * with a vertical rail, which sat oddly against everything else here being XP.
 */
#startmenu {
	/* Above the sign-on curtain (260), or the menu draws over it but the curtain takes the
	   clicks and every item looks broken. Still under the stop error, which owns the screen. */
	display: none; position: absolute; left: 2px; bottom: 28px; z-index: 550; width: 385px;
	flex-direction: column; font: 11px Tahoma, Arial, sans-serif; color: #00318f;
	border: 1px solid #0831d9; border-radius: 6px 6px 0 0;
	box-shadow: 3px 3px 10px rgba(0,0,0,.45);
}
#startmenu.open { display: flex }
#startmenu .head {
	display: flex; align-items: center; gap: 9px; padding: 6px 9px; height: 54px;
	border-radius: 5px 5px 0 0; color: #fff; font: bold 15px "Trebuchet MS", Tahoma, sans-serif;
	text-shadow: 1px 1px 2px rgba(0,0,0,.5);
	background: linear-gradient(180deg, #1b56c4 0%, #2f76e0 12%, #1c56c8 44%, #164ab5 100%);
	border-bottom: 2px solid #d8ecfc;
}
#startmenu .head img {
	width: 42px; height: 42px; flex: none; background: #fff; padding: 1px;
	border: 2px solid #e3edfb; border-radius: 3px;
	/* Contained, not covered: the face is taller than it is wide, and cover ate the chin. */
	object-fit: contain;
}
#startmenu .cols { display: flex; background: #fff; border-bottom: 2px solid #d8ecfc }
#startmenu .cols ul { list-style: none; margin: 0; padding: 5px 0; flex: 1 }
/* The right column is the pale blue one, and it is narrower than the left. */
#startmenu .cols .right { flex: 0 0 168px; background: #d3e5fa; padding: 5px 0 }
#startmenu li {
	display: flex; align-items: center; gap: 8px; padding: 5px 10px; line-height: 1.2;
}
#startmenu li:hover { background: #2f71cd; color: #fff }
#startmenu li b { display: block; font-weight: bold }
#startmenu li small { display: block; font-size: 10px; color: #4a6fa5 }
#startmenu li:hover small { color: #dbe8fb }
#startmenu li.sep { padding: 0; margin: 4px 10px; height: 1px; background: #b6d3ef }
#startmenu li.sep:hover { background: #b6d3ef }
#startmenu li img, #startmenu li .ico {
	width: 24px; height: 24px; flex: none; text-align: center; font-size: 17px; line-height: 24px;
}
#startmenu .cols .right li img, #startmenu .cols .right li .ico {
	width: 20px; height: 20px; font-size: 14px; line-height: 20px;
}
#startmenu .foot {
	display: flex; justify-content: flex-end; gap: 14px; padding: 6px 12px;
	background: linear-gradient(180deg, #1c56c8 0%, #2f76e0 40%, #164ab5 100%);
	color: #fff; text-shadow: 1px 1px 2px rgba(0,0,0,.5);
}
#startmenu .foot button {
	display: flex; align-items: center; gap: 6px; border: 0; background: none;
	color: inherit; font: inherit; text-shadow: inherit; padding: 2px 4px;
}
#startmenu .foot button:hover { text-decoration: underline }
#startmenu .foot .badge {
	width: 21px; height: 21px; border-radius: 3px; display: flex; align-items: center;
	justify-content: center; font-size: 12px; color: #fff;
	box-shadow: inset 0 1px 0 rgba(255,255,255,.5), 0 1px 2px rgba(0,0,0,.35);
}
#startmenu .foot .off { background: linear-gradient(180deg, #f08e3c, #d1471a) }
#startmenu .foot .logoff { background: linear-gradient(180deg, #6fa8e8, #2a63c4) }

/* ---- Sign On: the first screen, and the click that lets the modem be heard ---- */
#signon { display: none; position: absolute; inset: 0; z-index: 260; align-items: center; justify-content: center }
#signon.open { display: flex }
/* Windows stay out of sight until sign-on completes. */
#screen.signing .child:not(#signonwin):not(#introwin) { visibility: hidden }
#signonwin { width: 420px }
#signonbody { display: flex; background: #efeee2 }
#signonbody .side {
	width: 116px; flex: none; padding: 16px 8px 10px; text-align: center; color: #cfe3f5;
	display: flex; flex-direction: column; align-items: center;
	background: linear-gradient(180deg, #2a7fbd, #14527e);
}
#signonbody .side img { width: 62px; height: 62px }
#signonbody .side .name { margin-top: 6px; font: italic bold 15px Georgia, serif; color: #fff }
#signonbody .side .ver { margin-top: auto; font-size: 10px; opacity: .85 }
#signonbody .fields { flex: 1; padding: 16px 16px 12px }
#signonbody label { display: block; font-weight: bold; margin: 0 0 3px }
#signonbody select, #signonbody input { width: 100%; margin-bottom: 12px }
#signonbody .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px }
#signonbody .row button { min-width: 84px }

/* ---- The sign-on dialog ---- */
#intro { display: none; position: absolute; inset: 0; z-index: 250; align-items: center; justify-content: center }
#intro.open { display: flex }
#introwin { width: min(660px, 86%); background: #f2f0e6 }
#introbody { padding: 16px 20px 14px; background: #f2f0e6 }
#intrologo { text-align: center; margin-bottom: 16px }
#intrologo img { height: 62px; width: auto }
#steps { display: flex; gap: 14px }
.step { flex: 1; text-align: center }
/* Empty lavender until the step is reached; the artwork lands as it becomes active. */
.step .box {
	height: 96px; background: #b8b7f4 no-repeat center / contain;
	border: 3px solid; border-color: #6a7ab8 #aab4dc #aab4dc #6a7ab8;
}
.step .cap { display: block; margin-top: 7px; color: #555 }
.step.on .cap { color: #000; font-weight: bold }
.step.on .box { box-shadow: 0 0 0 2px #17265c }
#introfoot { border-top: 2px solid #17265c; margin-top: 14px; padding-top: 12px; text-align: center }



/*
 * Quitting doesn't close a tab — it does what quitting Windows always seemed to. Over the
 * taskbar as well as the app, because a stop error takes the whole machine with it.
 */
#bsod { display: none; position: absolute; inset: 0; z-index: 600; background: #0078d7; color: #fff;
	flex-direction: column; justify-content: center; padding: 0 11%;
	font-family: "Segoe UI", Frutiger, Tahoma, sans-serif; font-weight: 300; cursor: default }
#bsod.open { display: flex }
#bsod .face { font-size: 96px; line-height: 1; margin-bottom: 34px }
#bsod .lead { font-size: 30px; line-height: 1.32; margin: 0 0 30px; max-width: 20em }
#bsod .code { font-size: 14px; margin: 0; line-height: 1.6 }
#bsod .hint { margin-top: 26px; color: rgba(255,255,255,.72) }

/*
 * ---- Channel windows ----
 *
 * Each channel opens in a window dressed as its own application — WhatsApp in WhatsApp
 * green, Slack as Slack, Discord dark, and so on — while keeping the XP title bar and
 * frame, so the desktop stays one machine running several apps rather than a costume
 * change per click. SMS is the deliberate exception below: it isn't a window at all.
 */
.conv { display: none }
.conv.open { display: flex }
/* Same specificity dance as the reader: ".open" outranks a bare ".min". */
.conv.open.min, .conv.open.closed { display: none }

/* ---- WhatsApp ---- */
#wahead {
	display: flex; align-items: center; gap: 9px; padding: 7px 11px;
	background: #075e54; color: #fff; font: 13px "Segoe UI", Tahoma, sans-serif;
}
#wahead .face {
	width: 32px; height: 32px; border-radius: 50%; flex: none;
	background: #cfd8d5; display: flex; align-items: center; justify-content: center;
	font-size: 19px; color: #fff; overflow: hidden;
}
#wahead .face img { width: 100%; height: 100%; object-fit: cover }
#wahead .who { min-width: 0 }
#wahead .who b { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
#wahead .who small { display: block; font-size: 11px; opacity: .82 }
/* The doodle wallpaper, abstracted: WhatsApp's beige with a faint diagonal weave. */
#wachat {
	flex: 1; overflow: auto; padding: 10px 12px; min-height: 0;
	background: #e5ddd5;
	background-image: repeating-linear-gradient(45deg, rgba(0,0,0,.017) 0 2px, transparent 2px 11px),
		repeating-linear-gradient(-45deg, rgba(255,255,255,.05) 0 2px, transparent 2px 13px);
	font: 12.5px "Segoe UI", Tahoma, sans-serif;
}
.wachip {
	display: table; margin: 0 auto 9px; padding: 4px 10px; border-radius: 7px;
	background: #e1f2fa; color: #54656f; font-size: 11px; text-align: center;
	box-shadow: 0 1px 0 rgba(0,0,0,.08);
}
.wachip.crypt { background: #fdf4c5; color: #54655a }
/* Every bubble is outgoing — this inbox only ever catches your app talking. */
.wamsg {
	position: relative; margin: 3px 0 3px auto; padding: 5px 8px 6px 9px; max-width: 82%;
	width: fit-content; background: #dcf8c6; border-radius: 8px 0 8px 8px;
	box-shadow: 0 1px 0 rgba(0,0,0,.12); word-wrap: break-word; white-space: pre-wrap;
}
.wamsg::after {
	content: ""; position: absolute; top: 0; right: -7px;
	border: 7px solid transparent; border-top-color: #dcf8c6; border-left-color: #dcf8c6;
	border-width: 0 7px 7px 0;
}
.wamsg b.subj { display: block; margin-bottom: 1px }
/* The template card: a little document, the way WhatsApp shows one it sent for you. */
.watpl {
	display: flex; align-items: center; gap: 7px; margin: 2px 0 3px; padding: 6px 8px;
	background: #cfeeba; border-radius: 6px; color: #33691e;
}
.watpl small { display: block; color: #558b2f; font-size: 10px; letter-spacing: .06em }
.wameta {
	display: flex; justify-content: flex-end; align-items: center; gap: 3px;
	margin: 2px -2px -2px 10px; font-size: 10.5px; color: #8696a0; float: right;
}
/* Two grey ticks, drawn — never blue: nobody has read this, and nobody ever will. */
.waticks { display: inline-flex; width: 17px; height: 11px }
.wasys { clear: both; text-align: center; color: #8696a0; font-size: 11px; margin: 7px 0 }
#wafoot {
	display: flex; align-items: center; gap: 7px; padding: 7px 9px;
	background: #f0f2f5; border-top: 1px solid #d6dbdf;
}
#wafoot .wain {
	flex: 1; display: flex; align-items: center; gap: 7px; padding: 6px 11px;
	background: #fff; border-radius: 18px; border: 1px solid #e4e7ea;
}
#wafoot input {
	flex: 1; border: 0; outline: 0; background: none; min-width: 0;
	font: 12.5px "Segoe UI", Tahoma, sans-serif;
}
#wafoot .icobtn { border: 0; background: none; font-size: 17px; color: #54656f; padding: 0 2px; box-shadow: none; min-width: 0; min-height: 0 }

/*
 * ---- The chat platforms ----
 *
 * One window, four wardrobes: the platform the send was bound for arrives on the capture,
 * and the skin follows it. A chat whose platform the capture doesn't name still opens in
 * the Messenger window above — MSN is the fallback costume, not a fifth brand.
 */
#platwin .plathead {
	display: flex; align-items: center; gap: 8px; padding: 8px 12px;
	font: bold 13px "Segoe UI", Tahoma, sans-serif;
}
#platwin .plathead small { font-weight: normal; font-size: 11px; opacity: .78; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
#plathist { flex: 1; overflow: auto; min-height: 0; padding: 10px 12px; font: 12.5px "Segoe UI", Tahoma, sans-serif }
#plathist .msg { display: flex; gap: 8px; margin-bottom: 10px }
#plathist .pfp {
	width: 30px; height: 30px; flex: none; background: #fff; padding: 2px;
	display: flex; align-items: center; justify-content: center;
}
#plathist .pfp img { width: 100%; height: 100% }
#plathist .m-body { min-width: 0; flex: 1 }
#plathist .m-head b { margin-right: 6px }
#plathist .m-head .t { font-size: 10.5px; opacity: .6 }
#plathist .m-text { white-space: pre-wrap; word-wrap: break-word; margin-top: 1px }
#plathist .m-sys { font-size: 11px; font-style: italic; opacity: .65; margin: 8px 0 }
#platentry { display: flex; gap: 7px; padding: 8px 12px 10px; align-items: center }
#platentry input { flex: 1; min-width: 0; padding: 7px 10px; font: 12.5px "Segoe UI", Tahoma, sans-serif; outline: 0 }

/* Slack: white, workspace-purple accents, square avatars, sober. */
#platwin.plat-slack #platbody { background: #fff; color: #1d1c1d }
#platwin.plat-slack .plathead { background: #fff; color: #1d1c1d; border-bottom: 1px solid #ddd }
#platwin.plat-slack .plathead .dot { color: #616061 }
#platwin.plat-slack .pfp { border-radius: 4px; background: #4a154b }
#platwin.plat-slack .m-head b { color: #1d1c1d }
#platwin.plat-slack #platentry input { border: 1px solid #bbb; border-radius: 4px }
#platwin.plat-slack #platentry input:focus { border-color: #4a154b; box-shadow: 0 0 0 1px #4a154b }
/* Discord: the dark theme, because nobody has ever seen the light one. */
#platwin.plat-discord #platbody { background: #313338; color: #dbdee1 }
#platwin.plat-discord .plathead { background: #313338; color: #f2f3f5; border-bottom: 1px solid #26272b }
#platwin.plat-discord .plathead .dot { color: #80848e }
#platwin.plat-discord .pfp { border-radius: 50%; background: #5865f2 }
#platwin.plat-discord .m-head b { color: #949cf7 }
#platwin.plat-discord .m-sys { color: #80848e }
#platwin.plat-discord #platentry { background: #313338 }
#platwin.plat-discord #platentry input { background: #383a40; border: 0; border-radius: 8px; color: #dbdee1 }
/* Teams: the purple bar and cards, meetings not included. */
#platwin.plat-teams #platbody { background: #f0f0f0; color: #242424 }
#platwin.plat-teams .plathead { background: #464775; color: #fff }
#platwin.plat-teams .msg { background: #fff; border-radius: 4px; padding: 7px 9px; box-shadow: 0 1px 2px rgba(0,0,0,.12) }
#platwin.plat-teams .pfp { border-radius: 50%; background: #6264a7 }
#platwin.plat-teams #platentry input { border: 1px solid #d1d1d1; border-radius: 4px; background: #fff }
/* Telegram: the blue bar and green outgoing bubbles. */
#platwin.plat-telegram #platbody { background: #d2e3f0; color: #000 }
#platwin.plat-telegram .plathead { background: #2aabee; color: #fff }
#platwin.plat-telegram .msg { display: block; margin: 3px 0 3px auto; max-width: 82%; width: fit-content;
	background: #effdde; border-radius: 8px 8px 0 8px; padding: 5px 9px; box-shadow: 0 1px 1px rgba(0,0,0,.15) }
#platwin.plat-telegram .pfp, #platwin.plat-telegram .m-head b { display: none }
#platwin.plat-telegram .m-head .t { float: right; margin: 4px 0 0 8px; color: #62a85e; opacity: 1 }
#platwin.plat-telegram .m-sys { text-align: center }
#platwin.plat-telegram #platentry { background: #fff }
#platwin.plat-telegram #platentry input { border: 0 }
/* Bluesky: a white feed with hairlines between posts — no room, no bubbles, no privacy. */
#platwin.plat-bluesky #platbody { background: #fff; color: #0b0f19 }
#platwin.plat-bluesky .plathead { background: #fff; color: #0b0f19; border-bottom: 1px solid #d4dbe2 }
#platwin.plat-bluesky .plathead .dot { color: #1185fe; font-size: 15px }
#platwin.plat-bluesky #plathist { padding: 0 }
#platwin.plat-bluesky .msg { margin: 0; padding: 10px 12px; border-bottom: 1px solid #e6ebf0 }
#platwin.plat-bluesky .pfp { border-radius: 50%; background: #1185fe }
#platwin.plat-bluesky .m-head b { color: #0b0f19 }
#platwin.plat-bluesky .m-head .t { color: #42576c; opacity: 1 }
#platwin.plat-bluesky .m-sys { color: #42576c; padding: 0 12px }
#platwin.plat-bluesky #platentry { border-top: 1px solid #d4dbe2 }
#platwin.plat-bluesky #platentry input { border: 1px solid #d4dbe2; border-radius: 999px; background: #f7f9fa }
#platwin.plat-bluesky #platentry input:focus { border-color: #1185fe; box-shadow: 0 0 0 1px #1185fe; background: #fff }
#platbody { flex: 1; display: flex; flex-direction: column; min-height: 0 }

/* ---- The push notification shade ---- */
#pushbody {
	flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: auto; gap: 8px;
	padding: 10px; background: linear-gradient(180deg, #20242c 0%, #2a303c 100%);
	font: 12px "Segoe UI", Tahoma, sans-serif;
}
#pushbody .shadehead {
	display: flex; align-items: baseline; justify-content: space-between;
	color: #e8ebf0; padding: 2px 4px 4px;
}
#pushbody .shadehead b { font-size: 14px; font-weight: 600 }
#pushbody .shadehead button {
	border: 0; background: none; color: #9fb3d1; font: 11px "Segoe UI", Tahoma, sans-serif;
	box-shadow: none; min-width: 0; min-height: 0; text-decoration: underline;
}
.note { background: #fff; border-radius: 10px; padding: 8px 11px 9px; box-shadow: 0 2px 5px rgba(0,0,0,.35) }
.note .app {
	display: flex; align-items: center; gap: 5px; color: #667085;
	font-size: 10px; letter-spacing: .05em; text-transform: uppercase; margin-bottom: 3px;
}
.note .app img { width: 13px; height: 13px }
.note .app .t { margin-left: auto; text-transform: none; letter-spacing: 0 }
.note b.title { display: block; font-size: 12.5px }
.note .body { color: #333; white-space: pre-wrap; word-wrap: break-word }
.note .link { color: #1a6dc0; font-size: 11px; margin-top: 3px; word-break: break-all }
.note .data { font: 10.5px ui-monospace, "Courier New", monospace; color: #667085; margin-top: 3px; word-break: break-all }
.note .sched { display: block; margin-top: 3px }
.pushfoot { text-align: center; color: #9fb3d1; font-size: 11px; padding: 2px 0 4px }

/*
 * ---- POOM.EXE ----
 *
 * The other thing on the desktop. A black rectangle, a status bar with a face in it, and
 * numbers in the colours id used, because half of what makes that screen that screen is
 * the brown bar under it.
 */
#poom .title-bar-text { letter-spacing: .04em }
#poomstage { flex: 1; min-height: 0; background: #000; display: flex; padding: 3px }
#poom-view {
	width: 100%; height: 100%; display: block; image-rendering: pixelated;
	background: #000; border: 1px solid #26262c;
}
#poomhud {
	flex: none; display: flex; align-items: center; gap: 14px; padding: 5px 12px;
	background: linear-gradient(180deg, #6b5238 0%, #4a3826 55%, #34271a 100%);
	border-top: 2px solid #241a10; font: bold 11px "Courier New", monospace; color: #d8c6a4;
}
#poomhud .stat { display: flex; flex-direction: column; align-items: center; line-height: 1.1 }
#poomhud .stat b { font-size: 17px; color: #ff4b3a; text-shadow: 0 0 6px rgba(255,75,58,.5) }
#poomhud .spacer { flex: 1 }
/* The hint clips rather than wraps: a narrow window turned it into a column of one-word
   lines, which is worse than not reading it at all. */
#poomhud { overflow: hidden }
#poomhud .keys { font-size: 10px; color: #b09a76; text-align: right; line-height: 1.35; white-space: nowrap }
/* The mug shot, in its recessed frame — the face is the Postboi mark, taking the hits. */
#poom-faces {
	position: relative; display: block; width: 46px; height: 44px; flex: none;
	background: #1d1d22; border: 2px solid;
	border-color: #241a10 #7a5f40 #7a5f40 #241a10; padding: 1px;
}
#poom-faces img { position: absolute; inset: 1px; width: 42px; height: 40px; object-fit: contain; display: none }
#poom-faces.face-ok .f-ok, #poom-faces.face-hurt .f-hurt, #poom-faces.face-low .f-low,
#poom-faces.face-dead .f-dead, #poom-faces.face-won .f-won, #poom-faces.face-god .f-god,
#poom-faces.face-wink .f-wink, #poom-faces.face-godwink .f-godwink { display: block }
/* God mode: nothing can touch you, and the face knows it. */
#poom-faces.face-god, #poom-faces.face-godwink { background: #2a2410; box-shadow: inset 0 0 8px rgba(255,208,80,.55) }
#poom-faces.hit { background: #5a1410; translate: 0 1px }

/*
 * ---- The Pokia ----
 *
 * SMS doesn't get a window: a text lands on a handset, so a handset is what opens — a
 * skinned, shaped thing sitting on the desktop the way Winamp sat on one, draggable by
 * its body, no XP frame anywhere. It still registers with the window manager, so it has
 * a taskbar button and minimises with the rest when the app is taken down.
 */
#pokia { width: 254px; height: 596px; background: none }
.nk-shell {
	position: relative; width: 100%; height: 100%;
	/* The 3310's outline: barely-rounded shoulders, a deep sweep at the chin. */
	border-radius: 40px 40px 74px 74px / 30px 30px 96px 96px;
	background: linear-gradient(160deg, #3a5691 0%, #24386b 42%, #16244b 100%);
	box-shadow: inset 0 2px 4px rgba(255,255,255,.35), inset 0 -6px 12px rgba(0,0,0,.45),
		4px 8px 18px rgba(0,0,0,.55);
	padding: 13px 14px 0; display: flex; flex-direction: column; align-items: center;
	font: 11px Tahoma, Arial, sans-serif;
}
/* The seam: the silver line running round the front face, one inset ring's worth of it. */
.nk-shell::after {
	content: ""; position: absolute; inset: 4px; pointer-events: none;
	border-radius: 37px 37px 71px 71px / 27px 27px 93px 93px;
	box-shadow: inset 0 0 0 1px rgba(206,218,240,.34);
}
/* The power button on the crown — the only way a 3310 was ever turned off. */
.nk-power {
	position: absolute; top: -7px; left: 50%; translate: -50%;
	width: 54px; height: 12px; border: 0; border-radius: 6px 6px 2px 2px;
	background: linear-gradient(180deg, #10182e, #2c3f6e);
	box-shadow: inset 0 1px 1px rgba(255,255,255,.25); min-width: 0; min-height: 0;
}
.nk-power:active { translate: -50% 1px }
/* The earpiece: a short vertical ladder of slits above the wordmark, as the 3310 wore it. */
.nk-ear { display: flex; flex-direction: column; align-items: center; gap: 2px; margin: 1px 0 4px }
.nk-ear i {
	width: 4px; height: 2px; border-radius: 1px; background: #0b1229;
	box-shadow: inset 0 1px 1px rgba(0,0,0,.9), 0 1px 0 rgba(255,255,255,.12);
}
.nk-brand { color: #cdd6ea; font: bold 13px Arial, sans-serif; letter-spacing: 3px; margin-bottom: 6px }
.nk-bezel {
	width: 204px; padding: 9px; border-radius: 12px 12px 26px 26px;
	background: linear-gradient(180deg, #0e1428, #1a2547);
	box-shadow: inset 0 2px 5px rgba(0,0,0,.8), 0 1px 0 rgba(255,255,255,.14);
}
/*
 * The screen. The real one was 84×48 and showed four lines; this one is taller on purpose —
 * it is a mailbox as well as a handset, and squinting at four lines of a captured text is
 * being period-accurate at the reader's expense.
 */
.nk-lcd {
	position: relative; height: 214px; overflow: hidden; padding: 4px 5px;
	background: linear-gradient(180deg, #aec437 0%, #9cb52c 60%, #90a828 100%);
	box-shadow: inset 0 0 7px rgba(30,40,0,.45);
	font: bold 12px "Lucida Console", "Courier New", monospace; color: #22300a;
	line-height: 1.25; letter-spacing: .3px;
}
.nk-lcd .stat { display: flex; justify-content: space-between; align-items: flex-end; height: 13px; margin-bottom: 2px }
/* Signal on the left, battery on the right, both as the stepped bars. */
.nk-bars { display: flex; align-items: flex-end; gap: 1px }
.nk-bars i { width: 3px; background: #22300a }
.nk-title { text-align: center; border-bottom: 2px solid #22300a; padding-bottom: 1px; margin-bottom: 2px }
.nk-rows { height: 158px; overflow: hidden }
.nk-row { padding: 0 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.nk-row.on { background: #22300a; color: #aec437 }
.nk-read { height: 158px; overflow: hidden; white-space: pre-wrap; word-wrap: break-word }
.nk-soft { display: flex; justify-content: space-between; padding: 1px 2px 0; border-top: 1px dotted #22300a; margin-top: 2px }
.nk-soft span { padding: 0 2px }
.nk-empty { text-align: center; padding-top: 56px }
/* What the keypad has been typing, shown the way a handset shows a number being dialled. */
.nk-dial { position: absolute; right: 6px; bottom: 4px; letter-spacing: 2px; opacity: .75 }
/* Snake, drawn on its own canvas over the LCD text — same pixels, different program. */
#nk-game { position: absolute; inset: 0; width: 100%; height: 100%; display: none }
.nk-lcd.playing #nk-game { display: block }
.nk-lcd.playing #nk-screen { display: none }

/*
 * The keys. The 3310's front is one silver contour with the call keys cut out of it either
 * side of the centre button — not three loose buttons in a row, which is what this was.
 */
.nk-navi {
	position: relative; display: flex; align-items: center; justify-content: center;
	width: 212px; height: 46px; margin: 9px 0 7px;
	border-radius: 40px 40px 26px 26px / 30px 30px 20px 20px;
	background: linear-gradient(180deg, #e9edf4 0%, #c3ccdd 48%, #9fadc6 100%);
	box-shadow: inset 0 1px 1px rgba(255,255,255,.9), 0 2px 4px rgba(0,0,0,.45);
}
.nk-key {
	border: 0; color: #16223f; font: bold 12px Tahoma, sans-serif;
	background: linear-gradient(180deg, #e7ecf5 0%, #b9c4d8 55%, #94a3c0 100%);
	box-shadow: inset 0 1px 1px rgba(255,255,255,.8), 0 2px 3px rgba(0,0,0,.5);
	min-width: 0; min-height: 0;
}
.nk-key:active { box-shadow: inset 0 2px 3px rgba(0,0,0,.4); translate: 0 1px }
/* The two scroll keys, curving away from the centre button the way the 3310's did. */
.nk-side { position: absolute; top: 9px; width: 72px; height: 30px; font-size: 13px; line-height: 1 }
.nk-side.up { left: 6px; border-radius: 22px 8px 8px 22px / 20px 8px 8px 20px }
.nk-side.dn { right: 6px; border-radius: 8px 22px 22px 8px / 8px 20px 20px 8px }
/* The centre key: the oval with the teal bar across it. */
.nk-mid {
	position: relative; z-index: 1; width: 68px; height: 26px; border-radius: 14px;
	font-size: 0; background: linear-gradient(180deg, #eef1f7 0%, #ccd4e2 50%, #a7b4cb 100%);
}
.nk-mid::after {
	content: ""; position: absolute; left: 50%; top: 50%; translate: -50% -50%;
	width: 26px; height: 4px; border-radius: 2px; background: #3fb6c4;
	box-shadow: inset 0 1px 1px rgba(0,0,0,.35);
}
/* The centre key's job, spelled out under the band instead of on it — the 3310 had no
   label there either, and the screen's soft keys say what the buttons do. */
.nk-pad { width: 212px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px 8px; padding-bottom: 18px }
.nk-pad .nk-key { height: 30px; border-radius: 9px 22px 9px 22px; position: relative; font-size: 12px }
.nk-pad .nk-key small { position: absolute; right: 7px; bottom: 2px; font-size: 7px; letter-spacing: .5px; color: #3c4a68 }
`

const SCRIPT = `
var base = location.pathname.replace(/\\/+$/, "")
var FAVICON_URL = document.querySelector("link[rel=icon]").href
var api = base + "/api"
var messages = []
var current = null
var selected = null
var tab = "html"
var reports = {}
var shots_timer = null
var seen = 0
var loaded = false
var read = {}

function $(id) { return document.getElementById(id) }
function esc(value) {
	return String(value == null ? "" : value)
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
function who(list) {
	if (!list || !list.length) return ""
	return list.map(function (a) { return a.name ? a.name + " <" + a.address + ">" : a.address }).join(", ")
}
/* AOL's own M/D/YY, because half the charm is the date column looking wrong. */
function when(ms) {
	var d = new Date(ms)
	return (d.getMonth() + 1) + "/" + d.getDate() + "/" + String(d.getFullYear()).slice(2)
}
/* One h:mm AM/PM formatter for the taskbar clock and the messenger stamps alike. */
function stamp(ms) {
	var d = new Date(ms)
	var h = d.getHours()
	var m = d.getMinutes()
	var ampm = h >= 12 ? "PM" : "AM"
	h = h % 12
	if (!h) h = 12
	return h + ":" + (m < 10 ? "0" : "") + m + " " + ampm
}
function clock() {
	$("clock").textContent = stamp(Date.now())
}

/*
 * The two states a row can be in, drawn rather than set in type. The envelope glyph a font
 * gives you is a solid black lozenge at this size, and the emoji one is a full-colour sticker
 * that belongs to whichever OS is rendering it — neither looks like something Windows drew.
 * Cream on a dark outline so they read against a selected row as well as a white one.
 */
var ICON_SEALED =
	'<svg class="mailico" viewBox="0 0 16 13" aria-hidden="true">' +
	'<rect x=".5" y="1.5" width="15" height="10" fill="#fdfbf2" stroke="#3f3f3f"/>' +
	'<path d="M.5 1.5 8 7.6l7.5-6.1" fill="none" stroke="#3f3f3f"/>' +
	'<path d="M.5 11.5 5.9 6.5m4.2 0 5.4 5" fill="none" stroke="#cfcab4"/>' +
	"</svg>"
var ICON_OPEN =
	'<svg class="mailico" viewBox="0 0 16 13" aria-hidden="true">' +
	'<path d="M.5 4.6 8 .6l7.5 4" fill="#e6e1cc" stroke="#3f3f3f" stroke-linejoin="round"/>' +
	'<rect x=".5" y="4.6" width="15" height="7.4" fill="#fdfbf2" stroke="#3f3f3f"/>' +
	'<path d="M.5 11.6 5.9 7.3m4.2 0 5.4 4.3" fill="none" stroke="#cfcab4"/>' +
	"</svg>"
var FOLDERS = ["outbox", "sent", "scheduled", "deleted"]
var LABELS = { outbox: "Outbox", sent: "Sent", scheduled: "Scheduled", deleted: "Deleted" }
var EMPTY = {
	outbox:
		"Your outbox is empty.<br>Send anything from your app (mail, texts, chats, pushes) and it lands here.",
	sent: "Nothing has gone out yet.",
	scheduled: "Nothing is waiting on a clock.<br>Send with <b>scheduled_at</b> and it will queue up here.",
	deleted: "Nothing cancelled.<br>Call <b>cancel(id)</b> on a scheduled send and it will land here.",
}

/* Scheduled mail gets a clock over the envelope: it is not going anywhere yet. */
var ICON_CLOCK =
	'<svg class="mailico" viewBox="0 0 16 13" aria-hidden="true">' +
	'<rect x=".5" y="1.5" width="12" height="9" fill="#fdfbf2" stroke="#3f3f3f"/>' +
	'<path d="M.5 1.5 6.5 6.4l6-4.9" fill="none" stroke="#3f3f3f"/>' +
	'<circle cx="11.4" cy="8.6" r="4.1" fill="#fff2c9" stroke="#3f3f3f"/>' +
	'<path d="M11.4 6.3v2.4l1.7 1.1" fill="none" stroke="#3f3f3f" stroke-linecap="round"/>' +
	"</svg>"
/* Cancelled mail gets the bin, because that is where a send you called off has gone. */
var ICON_BIN =
	'<svg class="mailico" viewBox="0 0 16 13" aria-hidden="true">' +
	'<path d="M3.2 3.2h9.6l-.9 9.3H4.1z" fill="#e8e8e8" stroke="#3f3f3f" stroke-linejoin="round"/>' +
	'<path d="M2 3.2h12" fill="none" stroke="#3f3f3f"/>' +
	'<path d="M6.2 1.2h3.6v2H6.2z" fill="#cfcfcf" stroke="#3f3f3f" stroke-linejoin="round"/>' +
	'<path d="M6.6 5.4v5m2.8-5v5" fill="none" stroke="#8a8a8a"/>' +
	"</svg>"

/* The other channels' rows, drawn in the same hand as the envelopes. */
var ICON_BUBBLE =
	'<svg class="mailico" viewBox="0 0 16 13" aria-hidden="true">' +
	'<path d="M1.5 1.5h13V9H8l-3.4 2.8V9H1.5z" fill="#fdfbf2" stroke="#3f3f3f" stroke-linejoin="round"/>' +
	'<path d="M4 4.1h8.5M4 6.3h6" fill="none" stroke="#cfcab4"/>' +
	"</svg>"
var ICON_BELL =
	'<svg class="mailico" viewBox="0 0 16 13" aria-hidden="true">' +
	'<path d="M8 1.3c2.5 0 4 1.8 4 4.2 0 2.3.7 3.2 1.5 3.9h-11c.8-.7 1.5-1.6 1.5-3.9C4 3.1 5.5 1.3 8 1.3z" fill="#fff2c9" stroke="#3f3f3f" stroke-linejoin="round"/>' +
	'<path d="M6.7 10.4a1.4 1.4 0 0 0 2.6 0" fill="none" stroke="#3f3f3f"/>' +
	"</svg>"
var CHANNELS = ${JSON.stringify(CHANNEL_LABELS)}
function channel_of(m) { return m.channel || "email" }
/*
 * The chip for a row. A chat capture carries the platform it was bound for, so it says
 * "Slack" rather than "Chat" — "Chat" is what's left when the send didn't name one.
 */
function chan_chip(m) {
	var chan = channel_of(m)
	var look = chan === "chat" ? PLATFORMS[m.provider] : null
	var kind = look ? m.provider : chan
	return '<span class="chan c-' + esc(kind) + '">' + esc(look ? look.tag : CHANNELS[chan]) + "</span>"
}
function snip(text, n) {
	text = String(text == null ? "" : text)
	return text.length > n ? text.slice(0, n - 1) + "\\u2026" : text
}

/*
 * Which folder a captured message belongs in.
 *
 * Cancelled wins over everything: a scheduled send you called cancel() on is not still going
 * out, and showing it as though it were is the one answer that would mislead you. Otherwise
 * it is scheduled only while its moment is still ahead — once that passes it has, as far as
 * anything here is concerned, sent.
 */
function state_of(m) {
	if (m.cancelled_at) return "deleted"
	if (m.scheduled_at && new Date(m.scheduled_at).getTime() > Date.now()) return "scheduled"
	return "sent"
}
/** The folder showing. Outbox is everything still going out — sent and scheduled together. */
var folder = "outbox"
function in_folder(m) {
	var state = state_of(m)
	if (folder === "outbox") return state !== "deleted"
	return state === folder
}
/* Long enough to be unambiguous — the point of the column is the date, not the time of day. */
function when_full(iso) {
	var d = new Date(iso)
	if (isNaN(d.getTime())) return String(iso)
	return d.toLocaleString(undefined, {
		year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
	})
}

function render_list() {
	var tbody = $("rows")
	tbody.innerHTML = ""
	var shown = messages.filter(in_folder)
	var counts = { outbox: 0, sent: 0, scheduled: 0, deleted: 0 }
	messages.forEach(function (m) {
		var state = state_of(m)
		counts[state]++
		if (state !== "deleted") counts.outbox++
	})
	$("empty").style.display = shown.length ? "none" : "block"
	$("empty").innerHTML = EMPTY[folder]
	shown.forEach(function (m) {
		var tr = document.createElement("tr")
		var chan = channel_of(m)
		tr.className = (read[m.id] ? "" : "unread") + (selected && selected.id === m.id ? " on" : "")
		tr.innerHTML =
			'<td class="flag">' +
			(state_of(m) === "deleted"
				? ICON_BIN
				: state_of(m) === "scheduled"
					? ICON_CLOCK
					: chan === "email"
						? read[m.id]
							? ICON_OPEN
							: ICON_SEALED
						: chan === "push"
							? ICON_BELL
							: ICON_BUBBLE) +
			"</td>" +
			'<td class="when">' + when(m.received_at) + "</td>" +
			'<td class="who">' + esc(who(m.to)) + "</td>" +
			'<td class="chanco">' + chan_chip(m) + "</td>" +
			"<td>" +
			esc(snip(m.subject || (chan === "email" ? "(no subject)" : m.text || "(no message)"), 90)) +
			(m.cancelled_at
				? ' <span class="sched off">cancelled</span>'
				: state_of(m) === "scheduled"
					? ' <span class="sched">sends ' + esc(when_full(m.scheduled_at)) + "</span>"
					: "") +
			"</td>"
		tr.onclick = function () { select_message(m) }
		tr.ondblclick = function () { open_message(m) }
		tbody.appendChild(tr)
	})
	// Each tab shouts its count: a message that hasn't gone yet, or one that never will, is
	// exactly what you would want to know without going looking for it.
	FOLDERS.forEach(function (name) {
		var tab = $("f-" + name)
		var count = counts[name]
		tab.textContent = LABELS[name] + (count ? " (" + count + ")" : "")
		tab.className = folder === name ? "on" : ""
	})
	var unread = messages.filter(function (m) { return !read[m.id] }).length
	$("count").textContent =
		messages.length + " message" + (messages.length === 1 ? "" : "s") + (unread ? ", " + unread + " new" : "")
	document.title = (unread ? "(" + unread + ") " : "") + "Postboi Local"
	$("stat").textContent = messages.length ? "Ready" : "Waiting for mail\\u2026"
	sync_actions()
}

/** Highlight a row without opening it. Double-click, or Read, does the opening. */
function select_message(m) {
	selected = m
	render_list()
}

/**
 * Nothing to read once the mailbox is closed, or with no row picked — the buttons say so
 * rather than quietly acting on whatever happened to be open last. Called from the window
 * manager as well as the list, since closing the mailbox changes the answer.
 */
function sync_actions() {
	var mailbox = find("mailbox")
	var can_read = (!mailbox || mailbox.open) && !!selected
	$("keepnew").disabled = !can_read
	$("a-read").disabled = !can_read
	$("t-read").disabled = !can_read
}

/*
 * Where a message opens. Letters get the mail reader; every other channel gets a window
 * dressed as its own application — and SMS gets the handset. A chat whose platform the
 * capture doesn't name falls back to the MSN Messenger window: better a generic chat
 * app than a Slack window claiming a message that wasn't Slack's.
 */
function open_message(m) {
	selected = m
	read[m.id] = true
	var chan = channel_of(m)
	if (chan === "email") {
		current = m
		render_list()
		render_reader()
		return
	}
	if (chan === "sms") {
		nk_open = true
		nk_current = m
		nk_view = "read"
		nk_scroll = 0
		render_list()
		render_pokia()
		return
	}
	if (chan === "whatsapp") {
		wa_convo = m
		render_list()
		render_wa()
		return
	}
	if (chan === "push") {
		push_open = true
		render_list()
		render_push()
		return
	}
	if (PLATFORMS[m.provider]) {
		plat_convo = m
		render_list()
		render_plat()
		return
	}
	convo = m
	render_list()
	render_messenger()
}

function row(label, value) {
	return value ? "<dt>" + label + ':</dt><dd class="selectable">' + esc(value) + "</dd>" : ""
}

function render_reader() {
	var reader = $("reader")
	var win = find("reader")
	if (!current) {
		reader.className = "child window"
		if (win) {
			win.open = false
			if (focused === "reader") focused = "mailbox"
			paint()
		}
		return
	}
	reader.className = "child window open" + (win && win.min ? " min" : "")
	if (win) {
		win.title = current.subject || "(no subject)"
		var reopened = !win.open
		win.open = true
		if (reopened) focus_window("reader")
		else paint()
	}
	$("reader-title").textContent = current.subject || "(no subject)"
	var index = messages.indexOf(current)
	$("r-count").textContent = index < 0 ? "" : index + 1 + " of " + messages.length
	$("r-prev").disabled = index <= 0
	$("r-next").disabled = index < 0 || index >= messages.length - 1
	$("head").innerHTML =
		'<div class="subject selectable">' + esc(current.subject || "(no subject)") + "</div><dl>" +
		row("From", who([current.from])) +
		row("To", who(current.to)) +
		row("Cc", who(current.cc)) +
		row("Bcc", who(current.bcc)) +
		row("Reply-To", who(current.reply_to)) +
		row("Captured", new Date(current.received_at).toLocaleString()) +
		// Named "Sends" rather than "Sent" because it hasn't: this one is still waiting.
		(current.scheduled_at ? row("Sends", when_full(current.scheduled_at)) : "") +
		"</dl>" +
		(current.cancelled_at
			? '<div class="schedbar off">This send was cancelled. It was never going out.</div>'
			: state_of(current) === "scheduled"
				? '<div class="schedbar">This message is scheduled. It would not have gone out yet.</div>'
				: "")

	var tabs = $("tabs")
	Array.prototype.forEach.call(tabs.children, function (b) {
		b.className = b.dataset.tab === tab ? "on" : ""
	})

	var pane = $("pane")
	if (tab === "html") {
		if (!current.html && !current.text) {
			pane.innerHTML = '<div id="blank">This message has no body.</div>'
		} else {
			// sandbox with nothing allowed: the mail renders, its scripts don't run, and it
			// can't reach the dev server it happens to be served from.
			pane.innerHTML = '<iframe sandbox="" src="' + api + "/messages/" + current.id + '/body"></iframe>'
		}
	} else if (tab === "text") {
		pane.innerHTML = '<pre class="selectable">' + esc(current.text || "(no plain-text part)") + "</pre>"
	} else if (tab === "source") {
		pane.innerHTML = '<pre class="selectable">' + esc(current.html || current.text || "") + "</pre>"
	} else if (tab === "report") {
		render_report(pane)
	} else {
		var files = current.attachments || []
		if (!files.length) {
			pane.innerHTML = '<div id="blank">No attachments.</div>'
		} else {
			pane.innerHTML = '<div class="files">' + files.map(function (f, i) {
				var size = Math.round((f.content.length * 3) / 4 / 102.4) / 10
				return '<a download="' + esc(f.name) + '" href="' + api + "/messages/" + current.id + "/attachments/" + i +
					'">\\u{1F4CE} ' + esc(f.name) + " <span>(" + esc(f.mime_type) + ", " + size + " KB)</span></a>"
			}).join("") + "</div>"
		}
	}
}

/*
 * The Report tab: the captured message through postboi/inspect, fetched once per
 * message and remembered — the analysis is deterministic, so asking twice buys nothing.
 */
function render_report(pane) {
	var id = current.id
	if (reports[id]) {
		pane.innerHTML = report_html(reports[id]) + '<div class="report" id="rshots"></div>'
		return void paint_shots(id)
	}
	pane.innerHTML = '<div id="blank">Checking\\u2026</div>'
	fetch(api + "/messages/" + id + "/report").then(function (r) {
		// Only a real report enters the cache — a 404 body cached here would replay
		// as a synchronous throw on every later visit to the tab.
		if (!r.ok) throw new Error("report answered " + r.status)
		return r.json()
	}).then(function (report) {
		if (!report || !report.size) throw new Error("not a report")
		reports[id] = report
		if (current && current.id === id && tab === "report") {
			pane.innerHTML = report_html(report) + '<div class="report" id="rshots"></div>'
			paint_shots(id)
		}
	}).catch(function () {
		if (current && current.id === id && tab === "report") {
			pane.innerHTML = '<div id="blank">The report did not load. Close the reader and try again.</div>'
		}
	})
}

function report_html(report) {
	var MARKS = { error: "\\u2717", warning: "!", info: "\\u00b7" }
	var kb = Math.round(report.size.html_bytes / 102.4) / 10
	var head = report.findings.length
		? '<div class="r-status' + (report.status === "error" ? " error" : "") + '">' +
			report.findings.length + " finding" + (report.findings.length === 1 ? "" : "s") + "</div>"
		: '<div class="r-status pass">Looks good. Nothing to flag.</div>'
	var rows = report.findings.map(function (f) {
		var clients = (f.clients || []).map(function (c) {
			return c.name + (c.support === "partial" ? " (partial)" : "")
		}).join(", ")
		return '<li class="' + esc(f.severity) + '"><span class="r-mark">' + MARKS[f.severity] + "</span>" +
			esc(f.message) + (clients ? '<br><span class="r-clients">' + esc(clients) + "</span>" : "") + "</li>"
	}).join("")
	return '<div class="report selectable">' + head + "<ul>" + rows + "</ul>" +
		'<div class="r-size">HTML: ' + kb + " KB" + (report.size.gmail_clip ? ", Gmail will clip this" : "") +
		" \\u00b7 " + report.links.length + " link" + (report.links.length === 1 ? "" : "s") +
		" \\u00b7 " + report.images.length + " image" + (report.images.length === 1 ? "" : "s") + "</div></div>"
}

/*
 * Real-client screenshots for the open capture, through the hosted testing API. The
 * server keeps the token and proxies everything; this only asks, draws, and — while
 * the farm is still developing a capture — asks again in a little while.
 */
function paint_shots(id) {
	clearTimeout(shots_timer)
	var box = document.getElementById("rshots")
	if (!box || !current || current.id !== id || tab !== "report") return
	fetch(api + "/messages/" + id + "/screenshots").then(function (r) {
		if (!r.ok) throw new Error("screenshots answered " + r.status)
		return r.json()
	}).then(function (data) {
		if (!current || current.id !== id || tab !== "report") return
		var el = document.getElementById("rshots")
		if (!el) return
		el.innerHTML = shots_html(id, data)
		var go = document.getElementById("rshotgo")
		if (go) go.onclick = function () { order_shots(id, go) }
		Array.prototype.forEach.call(el.querySelectorAll(".r-open"), function (cell) {
			cell.onclick = function () { open_shot(id, cell.dataset.shot, data.previews) }
		})
		// A capture that was still developing when the viewer opened is ready now: keep
		// its Prev/Next honest without stealing focus from whatever you're reading.
		var shotwin = find("shotwin")
		if (shot_msg === id && shotwin && shotwin.open) {
			var showing = shot_list[shot_at]
			shot_list = (data.previews || []).filter(function (p) { return p.status === "ready" })
			shot_at = Math.max(0, shot_list.map(function (p) { return p.id })
				.indexOf(showing && showing.id))
			render_shot()
		}
		// The farm refused: the reason is the vendor's own ("Out of renders \\u2014 6 clients
		// skipped"), and a bare "no capture" tells the reader nothing they can act on.
		var errored = (data.previews || []).filter(function (p) { return p.error })
		// The allowance marker is the refusal the billing keys answer — prefer it
		// over an ordinary failed capture when both are present.
		var refused = errored.filter(function (p) { return p.client_name === "Screenshots" })[0] ||
			errored[0]
		if (refused) {
			// Raised once per run: the pane repolls every five seconds, and a dialog that
			// came back on each pass would be one you cannot dismiss. The holder brings it
			// back by hand.
			if (!alerted[data.run_id]) {
				alerted[data.run_id] = true
				show_alert("Postboi - Screenshots", refused.error, data.billing)
			}
			Array.prototype.forEach.call(el.querySelectorAll(".r-why"), function (why) {
				why.onclick = function () {
					// Each refusal speaks for itself — two failed rows carry two reasons.
					show_alert("Postboi - Screenshots", why.dataset.err || refused.error, data.billing)
				}
			})
		}
		var developing = (data.previews || []).some(function (p) { return p.status === "pending" })
		if (data.run_id && (developing || !(data.previews || []).length)) {
			shots_timer = setTimeout(function () { paint_shots(id) }, 5000)
		}
	}).catch(function () {
		shots_timer = setTimeout(function () { paint_shots(id) }, 5000)
	})
}

function order_shots(id, go) {
	go.disabled = true
	go.textContent = "Ordering\\u2026"
	fetch(api + "/messages/" + id + "/screenshots", { method: "POST" }).then(function (r) {
		if (!r.ok) return r.json().then(function (body) {
			throw new Error(body && body.error ? body.error : "order answered " + r.status)
		})
	}).then(function () {
		paint_shots(id)
	}).catch(function (error) {
		var el = document.getElementById("rshots")
		if (el) el.innerHTML = '<div class="r-shead">Real clients</div><div class="r-snote">' +
			esc(String((error && error.message) || error)) + "</div>"
	})
}

function shots_html(id, data) {
	var head = '<div class="r-shead">Real clients</div>'
	if (!data.run_id && !data.enabled) {
		return head + '<div class="r-snote">Set POSTBOI_TOKEN (your hosted API token) to photograph this ' +
			"email in real clients (Outlook, Gmail, Apple Mail) right from here.</div>"
	}
	if (!data.run_id) {
		return head + '<div class="r-snote"><button id="rshotgo">\\uD83D\\uDCF7 Photograph in real clients</button>' +
			" Uses your monthly preview allowance, one preview per client.</div>"
	}
	var cells = (data.previews || []).map(function (p) {
		if (p.status === "ready") {
			var src = api + "/messages/" + id + "/screenshots/" + p.id
			// Opens in the viewer window rather than a new browser tab: a capture is a thing
			// on this desktop like every other, and a raw PNG on a blank tab loses which
			// client it came from.
			return '<figure class="r-shot"><button type="button" class="r-open" data-shot="' + esc(p.id) + '">' +
				'<img loading="lazy" src="' + src + '" alt="' + esc(p.client_name) + '"></button>' +
				"<figcaption>" + esc(p.client_name) + "</figcaption></figure>"
		}
		var hold = p.status === "pending" ? "developing\\u2026" : p.error || "no capture"
		// A refusal is the one holder worth clicking: it is the whole reason the grid is
		// empty, and the way out of it is a page on the account, not anything here.
		if (p.error) {
			return '<figure class="r-shot"><button type="button" class="r-hold r-why" data-err="' +
				esc(p.error) + '">' + esc(hold) + "</button><figcaption>" +
				esc(p.client_name) + "</figcaption></figure>"
		}
		return '<figure class="r-shot"><div class="r-hold">' +
			esc(hold) + "</div><figcaption>" + esc(p.client_name) + "</figcaption></figure>"
	}).join("")
	var grid = '<div class="r-sgrid">' +
		(cells || '<div class="r-snote">Submitting to the rendering farm\\u2026</div>') + "</div>"
	// Nothing rendered and nothing coming: offer the order key again, so credits bought
	// in the tab you just came back from have something to be spent on.
	var nothing = (data.previews || []).length > 0 &&
		!(data.previews || []).some(function (p) {
			return p.status === "ready" || p.status === "pending"
		})
	if (nothing) {
		grid += '<div class="r-snote"><button id="rshotgo">\\uD83D\\uDCF7 Try again</button>' +
			" After topping up, this re-photographs the email." + "</div>"
	}
	return head + grid
}

/*
 * The system message box. Its billing link is where the account it was ordered from tops
 * up — never a hardcoded postboi.app, because the run may have come from staging or
 * from a self-hosted instance.
 */
var alert_billing = null
/* Raised once per run: the shots pane repolls every five seconds, and a dialog that came
 * back on each pass would be one you cannot dismiss. */
var alerted = {}

function show_alert(title, text, billing) {
	alert_billing = billing || null
	$("alert-title").textContent = title
	$("alert-text").textContent = text
	// Only offer a way to pay when we know where to send them.
	$("alert-upgrade").style.display = alert_billing && alert_billing.plan ? "" : "none"
	$("alert-topup").style.display = alert_billing && alert_billing.packs ? "" : "none"
	var win = find("alertwin")
	if (win) win.title = title
	open_window("alertwin")
}

/*
 * The capture viewer: which run's shots are open and which one is showing. Held here
 * rather than read off the DOM so Prev/Next survive the report pane repainting under
 * them — it repolls while captures are still developing.
 */
var shot_list = []
var shot_at = 0
var shot_msg = null

function open_shot(id, preview_id, previews) {
	shot_msg = id
	shot_list = (previews || []).filter(function (p) { return p.status === "ready" })
	shot_at = Math.max(0, shot_list.map(function (p) { return p.id }).indexOf(preview_id))
	render_shot()
	open_window("shotwin")
}

function render_shot() {
	var p = shot_list[shot_at]
	if (!p) return
	var win = find("shotwin")
	var title = p.client_name + " - Preview"
	$("shot-title").textContent = title
	if (win) win.title = title
	$("shot-img").src = api + "/messages/" + shot_msg + "/screenshots/" + p.id
	$("shot-img").alt = "Rendering in " + p.client_name
	$("shot-count").textContent = shot_list.length > 1
		? shot_at + 1 + " of " + shot_list.length
		: p.client_name
	// One capture is not a set to step through.
	$("shot-prev").disabled = shot_list.length < 2
	$("shot-next").disabled = shot_list.length < 2
	paint()
}

function step_shot(by) {
	if (shot_list.length < 2) return
	shot_at = (shot_at + by + shot_list.length) % shot_list.length
	render_shot()
}

function load() {
	return fetch(api + "/messages").then(function (r) { return r.json() }).then(function (data) {
		messages = data.messages || []
		var refresh = function (m) {
			return m && (messages.filter(function (x) { return x.id === m.id })[0] || null)
		}
		current = refresh(current)
		convo = refresh(convo)
		wa_convo = refresh(wa_convo)
		plat_convo = refresh(plat_convo)
		nk_current = refresh(nk_current)
		// Gated on having loaded once rather than on having seen a message: an inbox that starts
		// empty has seen zero, which is exactly when the next arrival is the first one to chime.
		if (loaded && messages.length > seen) play("mail")
		seen = messages.length
		loaded = true
		render_list()
		render_reader()
		render_messenger()
		render_wa()
		render_plat()
		render_push()
		render_pokia()
	})
}

/* ---- The Messenger window: one conversation per channel + destination ---- */
var convo = null
var extra_lines = []
var extra_key = null

function thread_key(m) { return channel_of(m) + "|" + who(m.to) }
function thread_of(m) {
	var key = thread_key(m)
	// messages is newest first; a conversation reads downwards.
	return messages.filter(function (x) { return thread_key(x) === key }).reverse()
}
function render_messenger() {
	var el = $("messenger")
	var win = find("messenger")
	if (!convo) {
		el.className = "child window"
		if (win) {
			win.open = false
			if (focused === "messenger") focused = "mailbox"
			paint()
		}
		return
	}
	var key = thread_key(convo)
	// The nudges and refused sends belong to one conversation, not to all of them.
	if (extra_key !== key) { extra_key = key; extra_lines = [] }
	var thread = thread_of(convo)
	// Opening a conversation reads the whole thread, the way a chat window would.
	thread.forEach(function (m) { read[m.id] = true })
	var to = who(convo.to)
	var chan = channel_of(convo)

	el.className = "child window open" + (win && win.min ? " min" : "")
	if (win) {
		win.title = to + " - Conversation"
		var reopened = !win.open
		win.open = true
		if (reopened) focus_window("messenger")
		else paint()
	}
	$("msn-title").textContent = to + " - Conversation"
	$("msn-to").textContent = to
	$("msn-chan").textContent = CHANNELS[chan] || chan

	var parts = [
		'<div class="sysline">' + esc(to) +
			" joins the conversation. Captured by the dev inbox. Nothing was actually sent.</div>",
	]
	thread.forEach(function (m) {
		parts.push(
			'<div class="says"><b>Your app</b> says: <span class="stamp">(' +
				stamp(m.received_at) + ")</span></div>"
		)
		if (m.subject && !m.template) parts.push('<div class="line"><b>' + esc(m.subject) + "</b></div>")
		if (m.text) parts.push('<div class="line">' + esc(m.text) + "</div>")
		if (m.template) parts.push('<div class="tpl">\\u{1F4CB} ' + esc(m.template) + "</div>")
		;(m.meta || []).forEach(function (pair) {
			parts.push('<div class="sysline">\\u2736 ' + esc(pair[0]) + ": " + esc(pair[1]) + "</div>")
		})
		if (m.cancelled_at) {
			parts.push('<div class="sysline">This send was cancelled. It was never going out.</div>')
		} else if (state_of(m) === "scheduled") {
			parts.push('<div class="sysline">Scheduled: sends ' + esc(when_full(m.scheduled_at)) + "</div>")
		}
	})
	var history = $("msnhistory")
	history.innerHTML = parts.concat(extra_lines).join("")
	history.scrollTop = history.scrollHeight
	render_list()
}

function msn_sys(text) {
	extra_lines.push('<div class="sysline">' + text + "</div>")
	render_messenger()
}
$("msn-send").onclick = function () {
	var box = $("msn-text")
	if (!box.value.trim()) return
	box.value = ""
	msn_sys("This glass is one-way: your app does the talking. Nothing was sent.")
}
$("msn-nudge").onclick = function () {
	var el = $("messenger")
	el.classList.remove("nudging")
	void el.offsetWidth
	el.classList.add("nudging")
	msn_sys("You have just sent a nudge. It was captured, and will never arrive.")
}
$("msnbar").addEventListener("click", function (event) {
	var button = event.target
	while (button && button !== this && !(button.dataset && button.dataset.say)) {
		button = button.parentNode
	}
	if (button && button.dataset && button.dataset.say) msn_sys(button.dataset.say)
})

/*
 * ---- The channel windows ----
 *
 * Each of these mirrors the messenger's contract with the window manager: a state
 * variable says whether it has anything to show, the renderer opens or closes the
 * window to match, and closing the window clears the state. They are all children of
 * the desktop like the mailbox is, so minimising Postboi Local stashes them too.
 */

/* ---- WhatsApp ---- */
var wa_convo = null

/* Two grey ticks, drawn inline. Never blue: nobody has read this, and nobody ever will. */
var WA_TICKS =
	'<svg class="waticks" viewBox="0 0 17 11" aria-hidden="true">' +
	'<path d="M1 6l3 3 6-7M7 8.2 8.5 9.5l6-7" fill="none" stroke="#8696a0" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
	"</svg>"
/* The pending clock, which is exactly what a scheduled send is. */
var WA_CLOCK =
	'<svg class="waticks" viewBox="0 0 17 11" aria-hidden="true">' +
	'<circle cx="8.5" cy="5.5" r="4.6" fill="none" stroke="#8696a0"/>' +
	'<path d="M8.5 3v2.8l2 1.2" fill="none" stroke="#8696a0" stroke-linecap="round"/>' +
	"</svg>"

function render_wa() {
	var el = $("wawin")
	var win = find("wawin")
	if (!wa_convo) {
		el.className = "child window conv"
		if (win) {
			win.open = false
			if (focused === "wawin") focused = "mailbox"
			paint()
		}
		return
	}
	var thread = thread_of(wa_convo)
	thread.forEach(function (m) { read[m.id] = true })
	var to = who(wa_convo.to)

	el.className = "child window conv open" + (win && win.min ? " min" : "")
	if (win) {
		win.title = to + " - WhatsApp"
		var reopened = !win.open
		win.open = true
		if (reopened) focus_window("wawin")
		else paint()
	}
	$("wa-title").textContent = to
	$("wa-to").textContent = to

	var parts = [
		'<div class="wachip crypt">\\u{1F512} Messages in this chat are end-to-end captured. ' +
			"Nothing was sent, and nothing will be.</div>",
		'<div class="wachip">TODAY</div>',
	]
	thread.forEach(function (m) {
		var inner = ""
		if (m.subject && !m.template) inner += '<b class="subj">' + esc(m.subject) + "</b>"
		if (m.template) {
			inner +=
				'<span class="watpl">\\u{1F4C4} <span>' + esc(m.template) +
				"<small>TEMPLATE \\u00B7 pre-approved</small></span></span>"
		}
		if (m.text) inner += esc(m.text)
		inner +=
			'<span class="wameta">' + stamp(m.received_at) +
			(state_of(m) === "scheduled" ? WA_CLOCK : WA_TICKS) + "</span>"
		parts.push('<div class="wamsg">' + inner + "</div>")
		;(m.meta || []).forEach(function (pair) {
			parts.push('<div class="wasys">' + esc(pair[0]) + ": " + esc(pair[1]) + "</div>")
		})
		if (m.cancelled_at) {
			parts.push('<div class="wasys">This send was cancelled. It was never going out.</div>')
		} else if (state_of(m) === "scheduled") {
			parts.push('<div class="wasys">Scheduled: sends ' + esc(when_full(m.scheduled_at)) + "</div>")
		}
	})
	var chat = $("wachat")
	chat.innerHTML = parts.join("")
	chat.scrollTop = chat.scrollHeight
	render_list()
}

function wa_sys(text) {
	var chat = $("wachat")
	chat.insertAdjacentHTML("beforeend", '<div class="wasys">' + text + "</div>")
	chat.scrollTop = chat.scrollHeight
}
$("wa-text").addEventListener("keydown", function (event) {
	if (event.key !== "Enter" || !this.value.trim()) return
	this.value = ""
	wa_sys("One-way glass: your app does the talking here. Nothing was sent.")
})
$("wafoot").addEventListener("click", function (event) {
	var button = event.target.closest("[data-wa]")
	if (button) wa_sys(button.dataset.wa)
})

/* ---- The chat platforms ---- */
var plat_convo = null

/*
 * The wardrobe rack. "room" is the fiction — a webhook doesn't know its channel's name,
 * so the window shows a plausible one and puts the real destination in the small print.
 */
var PLATFORMS = {
	slack: {
		name: "Slack", tag: "Slack", glyph: "#", room: "postboi-dev",
		sub: "Dev Workspace \\u00B7 nothing leaves this machine", ph: "Message #postboi-dev",
	},
	discord: {
		name: "Discord", tag: "Discord", glyph: "#", room: "general",
		sub: "Dev Server \\u00B7 0 members online", ph: "Message #general",
	},
	teams: {
		// The window says Microsoft Teams; the chip has a column 78px wide, so it says Teams.
		name: "Microsoft Teams", tag: "Teams", glyph: "\\u{1F465}", room: "General",
		sub: "Posts \\u00B7 the meeting never starts", ph: "Start a new conversation",
	},
	telegram: {
		name: "Telegram", tag: "Telegram", glyph: "\\u2708", room: "Dev Channel",
		sub: "captured by the dev inbox", ph: "Write a message\\u2026",
	},
	bluesky: {
		name: "Bluesky", tag: "Bluesky", glyph: "\\u{1F98B}", room: "Your feed",
		sub: "public in production \\u00B7 captured here", ph: "What's up?",
	},
}

/** The "Posts as" username a capture carried, if any — Slack and Discord webhooks take one. */
function posts_as(m) {
	var pair = (m.meta || []).filter(function (p) { return p[0] === "Posts as" })[0]
	return pair ? pair[1] : null
}

function render_plat() {
	var el = $("platwin")
	var win = find("platwin")
	if (!plat_convo) {
		el.className = "child window conv"
		if (win) {
			win.open = false
			if (focused === "platwin") focused = "mailbox"
			paint()
		}
		return
	}
	var look = PLATFORMS[plat_convo.provider]
	var thread = thread_of(plat_convo)
	thread.forEach(function (m) { read[m.id] = true })

	el.className = "child window conv open plat-" + plat_convo.provider + (win && win.min ? " min" : "")
	if (win) {
		win.title = look.glyph + look.room + " - " + look.name
		var reopened = !win.open
		win.open = true
		if (reopened) focus_window("platwin")
		else paint()
	}
	$("plat-title").textContent = look.glyph + look.room + " - " + look.name
	$("plat-glyph").textContent = look.glyph
	$("plat-name").textContent = look.room
	$("plat-sub").textContent = look.sub + " \\u00B7 " + who(plat_convo.to)
	$("plat-input").placeholder = look.ph

	var parts = ['<div class="m-sys">Captured by the dev inbox. Nothing was posted.</div>']
	thread.forEach(function (m) {
		var text = ""
		if (m.subject) text += "<b>" + esc(m.subject) + "</b>" + (m.text ? "\\n" : "")
		if (m.text) text += esc(m.text)
		parts.push(
			'<div class="msg"><span class="pfp"><img src="' + FAVICON_URL + '" alt=""></span>' +
				'<div class="m-body"><div class="m-head"><b>' + esc(posts_as(m) || "Your app") +
				'</b><span class="t">' + stamp(m.received_at) + "</span></div>" +
				'<div class="m-text">' + text + "</div></div></div>"
		)
		if (m.cancelled_at) {
			parts.push('<div class="m-sys">This send was cancelled. It was never going out.</div>')
		} else if (state_of(m) === "scheduled") {
			parts.push('<div class="m-sys">Scheduled: sends ' + esc(when_full(m.scheduled_at)) + "</div>")
		}
	})
	var hist = $("plathist")
	hist.innerHTML = parts.join("")
	hist.scrollTop = hist.scrollHeight
	render_list()
}

$("plat-input").addEventListener("keydown", function (event) {
	if (event.key !== "Enter" || !this.value.trim()) return
	this.value = ""
	var hist = $("plathist")
	hist.insertAdjacentHTML(
		"beforeend",
		'<div class="m-sys">One-way glass: your app does the posting. Nothing was sent.</div>'
	)
	hist.scrollTop = hist.scrollHeight
})

/* ---- The push notification shade ---- */
var push_open = false

function render_push() {
	var el = $("pushwin")
	var win = find("pushwin")
	var pushes = messages.filter(function (m) { return channel_of(m) === "push" })
	if (!push_open) {
		el.className = "child window conv"
		if (win) {
			win.open = false
			if (focused === "pushwin") focused = "mailbox"
			paint()
		}
		return
	}
	// The shade shows every notification at once, the way a shade does; opening it reads
	// them all, because pulling the shade down is how you read notifications.
	pushes.forEach(function (m) { read[m.id] = true })

	el.className = "child window conv open" + (win && win.min ? " min" : "")
	if (win) {
		win.title = "Notifications"
		var reopened = !win.open
		win.open = true
		if (reopened) focus_window("pushwin")
		else paint()
	}
	var parts = [
		'<div class="shadehead"><b>Notifications</b><button id="push-clear">Clear all</button></div>',
	]
	if (!pushes.length) {
		parts.push('<div class="note"><b class="title">No notifications</b>' +
			'<div class="body">Send with push() and it lands here.</div></div>')
	}
	pushes.forEach(function (m) {
		var rows =
			'<div class="app"><img src="' + FAVICON_URL + '" alt="">Postboi \\u00B7 your app' +
			'<span class="t">' + stamp(m.received_at) + "</span></div>"
		if (m.subject) rows += '<b class="title">' + esc(m.subject) + "</b>"
		if (m.text) rows += '<div class="body">' + esc(m.text) + "</div>"
		;(m.meta || []).forEach(function (pair) {
			if (pair[0] === "Opens") rows += '<div class="link">\\u{1F517} ' + esc(pair[1]) + "</div>"
			else rows += '<div class="data">' + esc(pair[0]) + ": " + esc(pair[1]) + "</div>"
		})
		if (m.cancelled_at) rows += '<span class="sched off">cancelled, was never going out</span>'
		else if (state_of(m) === "scheduled") {
			rows += '<span class="sched">sends ' + esc(when_full(m.scheduled_at)) + "</span>"
		}
		parts.push('<div class="note">' + rows + "</div>")
	})
	parts.push('<div class="pushfoot">Delivered to 0 devices. Captured by the dev inbox.</div>')
	$("pushbody").innerHTML = parts.join("")
	$("push-clear").onclick = function () {
		$("pushbody").lastChild.textContent =
			"They were never delivered, so there is nothing to clear."
	}
	render_list()
}

/*
 * ---- The Pokia ----
 *
 * The handset's whole screen is redrawn from state on every change, like the real
 * firmware would: a view (the inbox list or a message), a selection, and a scroll
 * offset. The phone shows every captured text — it is the recipient's pocket, not a
 * window onto one conversation.
 */
var nk_open = false
var nk_current = null
var nk_view = "list"
var nk_index = 0
var nk_scroll = 0
var nk_dial = ""
var nk_dial_timer = null
var NK_ROWS = 11
var NK_LINE = 15

function nk_messages() {
	return messages.filter(function (m) { return channel_of(m) === "sms" })
}

var NK_SIGNAL =
	'<span class="nk-bars"><i style="height:3px"></i><i style="height:5px"></i>' +
	'<i style="height:7px"></i><i style="height:9px"></i></span>'
var NK_BATTERY =
	'<span class="nk-bars"><i style="height:9px"></i><i style="height:9px"></i><i style="height:9px"></i></span>'

/*
 * The soft keys are the screen's, not the shell's: the labels at the bottom of the LCD say
 * what the centre key does, and clicking a label does it too. Everything the phone can be
 * asked to do goes through here, so the keypad, the wheel and the keyboard all agree.
 */
function nk_soft(left, right) {
	return '<div class="nk-soft"><span data-soft="left">' + esc(left) + "</span>" +
		'<span data-soft="right">' + esc(right) + "</span></div>"
}

function render_pokia() {
	var el = $("pokia")
	var win = find("pokia")
	if (!nk_open) {
		el.className = "child conv"
		if (win) {
			win.open = false
			if (focused === "pokia") focused = "mailbox"
			paint()
		}
		return
	}
	el.className = "child conv open" + (win && win.min ? " min" : "")
	if (win) {
		win.title = nk_view === "game" ? "Pokia \\u00B7 Snake" : "Pokia \\u00B7 Messages"
		var reopened = !win.open
		win.open = true
		if (reopened) focus_window("pokia")
		else paint()
	}
	var lcd = $("nk-lcd")
	var face = $("nk-screen")
	lcd.className = "nk-lcd" + (nk_view === "game" ? " playing" : "")
	if (nk_view === "game") return snake_draw()

	var texts = nk_messages()
	if (nk_current) {
		var i = texts.indexOf(nk_current)
		if (i >= 0) nk_index = i
	}
	nk_index = Math.max(0, Math.min(nk_index, texts.length - 1))
	texts.forEach(function (m) { read[m.id] = true })

	var head = '<div class="stat">' + NK_SIGNAL + NK_BATTERY + "</div>"
	var tail = nk_dial ? '<div class="nk-dial">' + esc(nk_dial) + "</div>" : ""
	if (!texts.length) {
		face.innerHTML = head + '<div class="nk-title">Messages</div>' +
			'<div class="nk-empty">No messages<br><br>Your app has not<br>texted yet</div>' +
			nk_soft(" ", "Back") + tail
		return
	}
	if (nk_view === "list") {
		// A window of rows around the selection, like the firmware scrolled its lists.
		var first = Math.max(0, Math.min(nk_index - (NK_ROWS - 1), texts.length - NK_ROWS))
		if (nk_index < first) first = nk_index
		var rows = texts.slice(first, first + NK_ROWS).map(function (m, offset) {
			var n = first + offset
			var label = (m.from && m.from.address) || "Your app"
			return '<div class="nk-row' + (n === nk_index ? " on" : "") + '" data-nkrow="' + n + '">' +
				esc(label) + " " + esc(snip(m.text || "", 24)) + "</div>"
		})
		face.innerHTML = head + '<div class="nk-title">Messages (' + texts.length + ')</div>' +
			'<div class="nk-rows">' + rows.join("") + "</div>" +
			nk_soft("Select", nk_index + 1 + "/" + texts.length) + tail
		return
	}
	var m = texts[nk_index]
	nk_current = m
	var body = "From: " + ((m.from && m.from.address) || "Your app") + "\\n" + (m.text || "")
	;(m.meta || []).forEach(function (pair) { body += "\\n" + pair[0] + ": " + pair[1] })
	if (m.cancelled_at) body += "\\nCancelled, never going out"
	else if (state_of(m) === "scheduled") body += "\\nSends " + when_full(m.scheduled_at)
	face.innerHTML = head + '<div class="nk-title">' + stamp(m.received_at) + "</div>" +
		'<div class="nk-read" id="nk-read">' + esc(body) + "</div>" +
		nk_soft("Back", "\\u2195 scroll") + tail
	$("nk-read").scrollTop = nk_scroll * NK_LINE
}

/** Up and down, wherever they come from: the side keys, the wheel, the arrow keys. */
function nk_step(delta) {
	if (nk_view === "game") return snake_turn(delta)
	if (nk_view === "list") {
		nk_index = Math.max(0, Math.min(nk_messages().length - 1, nk_index + delta))
		nk_current = null
	} else {
		nk_scroll = Math.max(0, nk_scroll + delta)
	}
	render_pokia()
}

/** The centre key: open the selected text, or come back out of the one that's open. */
function nk_select() {
	if (nk_view === "game") return snake_key("fire")
	if (nk_view === "list" && nk_messages().length) { nk_view = "read"; nk_scroll = 0 }
	else { nk_view = "list"; nk_current = null }
	render_pokia()
	render_list()
}

$("nk-up").onclick = function () { nk_step(-1) }
$("nk-dn").onclick = function () { nk_step(1) }
$("nk-mid").onclick = nk_select

/*
 * The screen answers to the mouse as well as to the keys. A phone from 2000 did nothing of
 * the sort — but this one is sitting on a desktop next to a pointer, and a list you can see
 * and can't click is a worse anachronism than a touchscreen.
 */
$("nk-lcd").addEventListener("click", function (event) {
	var soft = event.target.closest("[data-soft]")
	if (soft) {
		if (nk_view === "game") return soft.dataset.soft === "left" ? snake_key("fire") : snake_exit()
		if (soft.dataset.soft === "left") nk_select()
		return
	}
	var row = event.target.closest("[data-nkrow]")
	if (!row) return
	nk_index = Number(row.dataset.nkrow)
	nk_current = null
	nk_view = "read"
	nk_scroll = 0
	render_pokia()
	render_list()
})
$("nk-lcd").addEventListener("wheel", function (event) {
	if (!nk_open) return
	// The phone owns the gesture: the desktop behind it has nothing to scroll anyway, and a
	// flick that scrolled the page instead of the message would be the wrong thing every time.
	event.preventDefault()
	nk_step(event.deltaY > 0 ? 1 : -1)
}, { passive: false })

/*
 * The keypad. It types, and one thing on this phone is listening: S-N-A-K-E on the letters
 * printed on the keys — 76253 — is Snake, the way it was always somewhere in that menu.
 */
var SNAKE_CODE = "76253"
$("pokia").querySelector(".nk-pad").addEventListener("click", function (event) {
	var key = event.target.closest("[data-nk]")
	if (!key) return
	if (nk_view === "game") return snake_key(key.dataset.nk)
	nk_dial = (nk_dial + key.dataset.nk).slice(-8)
	clearTimeout(nk_dial_timer)
	// A number half-dialled and abandoned clears itself, as it did on the real thing.
	nk_dial_timer = setTimeout(function () { nk_dial = ""; render_pokia() }, 3000)
	if (nk_dial.slice(-SNAKE_CODE.length) === SNAKE_CODE) { nk_dial = ""; return snake_start() }
	render_pokia()
})

/* Arrow keys, WASD and Escape, but only while the handset is the focused window. */
document.addEventListener("keydown", function (event) {
	if (focused !== "pokia" || !nk_open) return
	var key = event.key
	var map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
		w: "up", s: "down", a: "left", d: "right" }
	var dir = map[key]
	if (nk_view === "game") {
		if (dir) { event.preventDefault(); snake_dir(dir) }
		else if (key === " " || key === "Enter") { event.preventDefault(); snake_key("fire") }
		else if (key === "Escape") snake_exit()
		return
	}
	if (dir === "up") { event.preventDefault(); nk_step(-1) }
	else if (dir === "down") { event.preventDefault(); nk_step(1) }
	else if (key === "Enter") { event.preventDefault(); nk_select() }
	else if (key === "Escape" && nk_view === "read") nk_select()
})

$("pokia").querySelector(".nk-power").onclick = function () {
	var win = find("pokia")
	if (win) close_window(win)
}
/* Dragged by the body, like Winamp — anywhere that isn't a key picks the phone up. */
$("pokia").addEventListener("mousedown", function (event) {
	if (event.target.closest("button")) return
	var win = find("pokia")
	if (win) drag(win, event)
})

/*
 * ---- Snake ----
 *
 * The one from the phone: a walled arena, a dot to eat, a tail that grows, and a speed that
 * creeps up until you make the mistake. Drawn on a canvas over the LCD in the same two
 * colours the rest of the screen has, so it reads as the same hardware running a game.
 *
 * Steering takes whatever you have to hand: 2/4/6/8 on the keypad, the arrow keys, or the
 * two side keys, which turn left and right relative to where the snake is already headed —
 * the only scheme that works with two buttons, and the one that makes them worth pressing.
 */
var CELL = 9
var snake = null
var snake_timer = null
var snake_best = Number(localStorage.getItem("postboi:snake") || 0)

function snake_start() {
	var lcd = $("nk-lcd")
	var canvas = $("nk-game")
	// Sized from the LCD it covers, not from a guess: the shell is styled in CSS and the
	// arena has to come out of whatever that leaves, or the pixels land between cells.
	canvas.width = lcd.clientWidth
	canvas.height = lcd.clientHeight
	var cols = Math.floor(canvas.width / CELL)
	var rows = Math.floor((canvas.height - 31) / CELL)
	snake = {
		cols: cols, rows: rows,
		body: [{ x: (cols >> 1) - 1, y: rows >> 1 }, { x: (cols >> 1) - 2, y: rows >> 1 }],
		dir: { x: 1, y: 0 },
		next: { x: 1, y: 0 },
		food: null,
		score: 0,
		over: false,
		// Paused on the splash: the code that starts the game is typed on the keypad, and a
		// snake already running into a wall while you look up from it is a rotten welcome.
		started: false,
		paused: true,
		speed: 220,
	}
	snake_feed()
	nk_view = "game"
	render_pokia()
	snake_tick_later()
}

/** Somewhere the snake isn't. The arena is small, so rejection sampling is the whole job. */
function snake_feed() {
	for (;;) {
		var spot = {
			x: Math.floor(Math.random() * snake.cols),
			y: Math.floor(Math.random() * snake.rows),
		}
		var hit = snake.body.some(function (part) { return part.x === spot.x && part.y === spot.y })
		if (!hit) { snake.food = spot; return }
	}
}

function snake_tick_later() {
	clearTimeout(snake_timer)
	if (!snake || snake.over || snake.paused || nk_view !== "game") return
	snake_timer = setTimeout(snake_tick, snake.speed)
}

function snake_tick() {
	if (!snake || snake.over || snake.paused) return
	snake.dir = snake.next
	var head = { x: snake.body[0].x + snake.dir.x, y: snake.body[0].y + snake.dir.y }
	var into_wall = head.x < 0 || head.y < 0 || head.x >= snake.cols || head.y >= snake.rows
	var into_self = snake.body.some(function (part) { return part.x === head.x && part.y === head.y })
	if (into_wall || into_self) {
		snake.over = true
		if (snake.score > snake_best) {
			snake_best = snake.score
			localStorage.setItem("postboi:snake", String(snake_best))
		}
		snake_draw()
		return
	}
	snake.body.unshift(head)
	if (head.x === snake.food.x && head.y === snake.food.y) {
		snake.score += 1
		// It gets faster the longer you last, with a floor — past that it is reflexes, not a game.
		snake.speed = Math.max(70, snake.speed - 6)
		snake_feed()
	} else snake.body.pop()
	snake_draw()
	snake_tick_later()
}

/** Absolute steering. A reversal into your own neck is the one input the game ignores. */
function snake_dir(name) {
	if (!snake || snake.over) return
	var want = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }[name]
	if (!want) return
	if (want.x === -snake.dir.x && want.y === -snake.dir.y) return
	snake.next = want
}

/** Relative steering, for the two side keys: -1 turns left, 1 turns right. */
function snake_turn(delta) {
	if (!snake || snake.over) return
	var d = snake.dir
	snake.next = delta < 0 ? { x: d.y, y: -d.x } : { x: -d.y, y: d.x }
}

function snake_key(key) {
	if (key === "2") return snake_dir("up")
	if (key === "8") return snake_dir("down")
	if (key === "4") return snake_dir("left")
	if (key === "6") return snake_dir("right")
	if (key === "*" || key === "#") return snake_exit()
	// Fire, 5, 0: restart when it's over, pause and unpause while it isn't.
	if (snake && snake.over) return snake_start()
	if (snake) {
		snake.started = true
		snake.paused = !snake.paused
		snake_draw()
		snake_tick_later()
	}
}

function snake_exit() {
	clearTimeout(snake_timer)
	snake = null
	nk_view = "list"
	render_pokia()
}

/* Everything is drawn in the LCD's own ink, on a canvas that lets the green through. */
var LCD_INK = "#22300a"
function snake_draw() {
	var canvas = $("nk-game")
	var ctx = canvas.getContext("2d")
	ctx.clearRect(0, 0, canvas.width, canvas.height)
	if (!snake) return
	ctx.fillStyle = LCD_INK
	ctx.font = 'bold 11px "Lucida Console", "Courier New", monospace'
	ctx.textBaseline = "top"
	ctx.fillText("SNAKE", 3, 1)
	var head_line = snake.score + (snake_best ? "  HI " + snake_best : "")
	ctx.fillText(head_line, canvas.width - 4 - ctx.measureText(head_line).width, 1)

	var top = 16
	var w = snake.cols * CELL
	var h = snake.rows * CELL
	var left = Math.floor((canvas.width - w) / 2)
	// The arena wall, which is the thing you crash into.
	ctx.strokeStyle = LCD_INK
	ctx.lineWidth = 2
	ctx.strokeRect(left - 2, top - 2, w + 4, h + 4)

	snake.body.forEach(function (part, i) {
		var size = i === 0 ? CELL - 1 : CELL - 3
		var pad = i === 0 ? 0 : 1
		ctx.fillRect(left + part.x * CELL + pad, top + part.y * CELL + pad, size, size)
	})
	// The dot, drawn as the ring the phone drew, so it never reads as a stubby tail.
	var f = snake.food
	ctx.lineWidth = 2
	ctx.strokeRect(left + f.x * CELL + 1.5, top + f.y * CELL + 1.5, CELL - 4, CELL - 4)

	// What the keys do, on the screen, because a game with no way out is a trap.
	var hint = snake.started ? "Fire pause  # exit" : ""
	ctx.fillText(hint, (canvas.width - ctx.measureText(hint).width) / 2, top + h + 3)

	if (snake.over || snake.paused) {
		var lines = snake.over
			? ["GAME OVER", "SCORE " + snake.score, snake.score >= snake_best ? "NEW BEST" : "BEST " + snake_best, "", "Fire: again", "# : messages"]
			: snake.started
				? ["PAUSED", "", "Fire: resume", "# : messages"]
				: ["SNAKE", "", "Fire to start", "2 4 6 8 or arrows", "\\u25B2 \\u25BC turn", "# : messages"]
		var box_h = lines.length * 13 + 10
		var box_y = top + Math.max(0, (h - box_h) / 2)
		ctx.fillStyle = "#aec437"
		ctx.fillRect(left + 6, box_y, w - 12, box_h)
		ctx.strokeStyle = LCD_INK
		ctx.strokeRect(left + 6, box_y, w - 12, box_h)
		ctx.fillStyle = LCD_INK
		lines.forEach(function (line, i) {
			ctx.fillText(line, left + (w - ctx.measureText(line).width) / 2, box_y + 6 + i * 13)
		})
	}
}


/*
 * ---- POOM.EXE ----
 *
 * Not Doom: Doom is a WAD file and a source port, neither of which fits in a dev server's
 * HTML. This is the shape of it — a raycaster with a floor-cast street, a shotgun with a
 * kick, and a status bar with a face on it that stops smiling as you take hits.
 *
 * The setting is a postman's: a suburban road, houses either side, picket fences, and the
 * spam coming up the path at you with its flap open. The monsters are junk mail because
 * this is a mail tool, and the round has to be finished either way.
 *
 * ponytail: a raycaster, not a BSP renderer. One wall height plus a short one for fences,
 * no doors, no stairs, no sound. Every texture is drawn into an offscreen canvas at boot
 * rather than shipped as an image — procedural bricks are cheaper than base64 ones.
 */
var POOM_W = 320
var POOM_H = 176
var TEX = 64

/*
 * The street. Ground: "." road, ":" pavement, "," grass. Tall: "H" house, "#" hedge.
 * Short (you see over these, they still stop you): "f" fence, digits a fence with a sign
 * nailed to it. Props, drawn as sprites: "T" tree, "P" pillar box.
 */
var POOM_MAP = [
	"############################################",
	"#,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,#",
	"#,HHHHHH,,HHHHHH,,,HHHHH,,HHHHHH,,HHHHHHH,,#",
	"#,HHHHHH,,HHHHHH,,,HHHHH,,HHHHHH,,HHHHHHH,,#",
	"#,HHHHHH,,HHHHHH,,,HHHHH,,HHHHHH,,HHHHHHH,,#",
	"#,,,,,,,T,,,,,,,,T,,,,,,,,,,,,,,T,,,,,,,,,,#",
	"#fff1fff,ffff2fff,fffffff,ff3ffff,fff6fffff#",
	"#::::::::::P:::::::::::::::::::::::::::::::#",
	"#..........................................#",
	"#..........................................#",
	"#..........................................#",
	"#:::::::::::::::::::::::::::::P::::::::::::#",
	"#fff4ff,ffffffff,fff5ffff,ffffff,fff7ffffff#",
	"#,,,,,,,T,,,,,,,,,,,,,,,T,,,,,,T,,,,,,,,,,,#",
	"#,HHHHH,,HHHHHH,,,HHHHHH,,HHHHH,,HHHHHHH,,,#",
	"#,HHHHH,,HHHHHH,,,HHHHHH,,HHHHH,,HHHHHHH,,,#",
	"#,HHHHH,,HHHHHH,,,HHHHHH,,HHHHH,,HHHHHHH,,,#",
	"#,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,#",
	"#,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,#",
	"############################################",
]

/* The signs on the fences. Somebody on this road has a label maker and a lot of feelings. */
var POOM_SIGNS = {
	1: ["BEWARE", "OF THE", "DOG"],
	2: ["NO JUNK", "MAIL"],
	3: ["NO", "COLD", "CALLERS"],
	4: ["PLEASE DO", "NOT FEED", "THE SPAM"],
	5: ["UNSUBSCRIBE", "IT WON'T", "HELP"],
	6: ["RETURN", "TO SENDER"],
	7: ["NO", "CIRCULARS", "THIS MEANS", "YOU"],
}

var POOM_W2 = POOM_W / 2
var POOM_TALL = "H#"
var POOM_SHORT = "f1234567"
var POOM_PROP = "TP"
var poom = null
var poom_frame = null
var poom_keys = {}
var poom_art = null

function poom_cell(x, y) {
	var row = POOM_MAP[Math.floor(y)]
	if (!row) return "#"
	var cell = row[Math.floor(x)]
	return cell === undefined ? "#" : cell
}
/** Everything but the three kinds of ground stops you walking into it. */
function poom_solid(x, y) { return ".:,".indexOf(poom_cell(x, y)) === -1 }
function poom_tall(x, y) { return POOM_TALL.indexOf(poom_cell(x, y)) !== -1 }

/* ---- The art department ---- */

function poom_canvas(w, h) {
	var c = document.createElement("canvas")
	c.width = w
	c.height = h
	return c
}

/*
 * A repeatable stream of "random" numbers. Textures generated from Math.random would be a
 * different house every time the window opened, which is the sort of thing you notice.
 */
function poom_rand(seed) {
	var state = seed
	return function () {
		state = (state * 1103515245 + 12345) % 2147483648
		return state / 2147483648
	}
}

function poom_grime(g, seed, strength, w, h) {
	var rand = poom_rand(seed)
	for (var i = 0; i < (w * h) / 5; i++) {
		var dark = rand() > 0.5
		g.fillStyle = (dark ? "rgba(0,0,0," : "rgba(255,255,255,") + (rand() * strength).toFixed(3) + ")"
		g.fillRect(Math.floor(rand() * w), Math.floor(rand() * h), 1, 1)
	}
}

/** Tarmac, with the worn white line down the middle of the road. */
function poom_tex_road() {
	var c = poom_canvas(TEX, TEX)
	var g = c.getContext("2d")
	g.fillStyle = "#3b3b40"
	g.fillRect(0, 0, TEX, TEX)
	poom_grime(g, 3, 0.3, TEX, TEX)
	g.fillStyle = "rgba(226,222,205,.8)"
	g.fillRect(TEX / 2 - 3, 8, 6, 22)
	g.fillRect(TEX / 2 - 3, 40, 6, 16)
	return c
}
function poom_tex_pavement() {
	var c = poom_canvas(TEX, TEX)
	var g = c.getContext("2d")
	g.fillStyle = "#8d8b84"
	g.fillRect(0, 0, TEX, TEX)
	g.fillStyle = "#7c7a73"
	g.fillRect(0, 0, TEX, 2)
	g.fillRect(0, 32, TEX, 2)
	g.fillRect(0, 0, 2, TEX)
	g.fillRect(32, 0, 2, TEX)
	poom_grime(g, 9, 0.22, TEX, TEX)
	return c
}
function poom_tex_grass() {
	var c = poom_canvas(TEX, TEX)
	var g = c.getContext("2d")
	g.fillStyle = "#4b7233"
	g.fillRect(0, 0, TEX, TEX)
	var rand = poom_rand(17)
	for (var i = 0; i < 700; i++) {
		var tone = 46 + Math.floor(rand() * 46)
		g.fillStyle = "rgb(" + Math.round(tone * 0.85) + "," + (tone + 44) + "," + Math.round(tone * 0.7) + ")"
		g.fillRect(Math.floor(rand() * TEX), Math.floor(rand() * TEX), 1, 2)
	}
	return c
}

/** The hedge that closes the road off at both ends. Nobody's round goes on for ever. */
function poom_tex_hedge() {
	var c = poom_canvas(TEX, TEX)
	var g = c.getContext("2d")
	g.fillStyle = "#24401f"
	g.fillRect(0, 0, TEX, TEX)
	var rand = poom_rand(29)
	for (var i = 0; i < 900; i++) {
		var tone = 40 + Math.floor(rand() * 60)
		g.fillStyle = "rgb(" + Math.round(tone * 0.55) + "," + tone + "," + Math.round(tone * 0.42) + ")"
		var s = 2 + Math.floor(rand() * 3)
		g.fillRect(Math.floor(rand() * TEX), Math.floor(rand() * TEX), s, s)
	}
	return c
}

/*
 * The houses. Six of them, no two alike: the render picks one per building rather than per
 * wall, so a house has the same front all the way along instead of changing every metre.
 */
var POOM_HOUSES = [
	{ wall: "#c9b79a", trim: "#f2ece0", door: "#7a2f22", roof: "#6b4a3a", brick: false, number: "12" },
	{ wall: "#9fb2c4", trim: "#ffffff", door: "#1f4f7a", roof: "#4a5a68", brick: false, number: "14" },
	{ wall: "#b5644f", trim: "#efe6d6", door: "#2f5136", roof: "#5a3a30", brick: true, number: "16" },
	{ wall: "#d8cba4", trim: "#fbf6ea", door: "#6b3a86", roof: "#7a6a4a", brick: false, number: "18" },
	{ wall: "#8fa38a", trim: "#f4f1e6", door: "#8a5a1f", roof: "#4d5a48", brick: false, number: "20" },
	{ wall: "#a8836b", trim: "#f6efe2", door: "#243a6b", roof: "#6a5140", brick: true, number: "22" },
]

function poom_tex_house(look) {
	var c = poom_canvas(TEX, TEX)
	var g = c.getContext("2d")
	g.fillStyle = look.wall
	g.fillRect(0, 0, TEX, TEX)
	if (look.brick) {
		for (var row = 0; row < 16; row++) {
			for (var col = -1; col < 8; col++) {
				g.fillStyle = "rgba(0,0,0,.13)"
				g.fillRect(col * 8 + (row % 2 ? 4 : 0), row * 4, 7, 3)
			}
		}
	} else {
		// Weatherboard: a shadow line under every plank.
		for (var y = 4; y < TEX; y += 5) {
			g.fillStyle = "rgba(0,0,0,.16)"
			g.fillRect(0, y, TEX, 1)
		}
	}
	// The roof line along the top, so a wall reads as a house even head-on.
	g.fillStyle = look.roof
	g.fillRect(0, 0, TEX, 9)
	g.fillStyle = "rgba(0,0,0,.25)"
	g.fillRect(0, 9, TEX, 2)
	g.fillStyle = look.trim
	g.fillRect(0, 11, TEX, 2)

	// Two windows over a door, which is what a front is.
	function window_at(x, y, w, h) {
		g.fillStyle = look.trim
		g.fillRect(x - 2, y - 2, w + 4, h + 4)
		g.fillStyle = "#2c3d4a"
		g.fillRect(x, y, w, h)
		g.fillStyle = "rgba(255,255,255,.22)"
		g.beginPath()
		g.moveTo(x, y + h)
		g.lineTo(x + w, y)
		g.lineTo(x + w, y + h * 0.45)
		g.lineTo(x + w * 0.4, y + h)
		g.closePath()
		g.fill()
		g.fillStyle = look.trim
		g.fillRect(x + w / 2 - 1, y, 2, h)
		g.fillRect(x, y + h / 2 - 1, w, 2)
	}
	window_at(8, 18, 16, 13)
	window_at(TEX - 24, 18, 16, 13)
	// Door, step and a number by the frame.
	g.fillStyle = look.trim
	g.fillRect(TEX / 2 - 10, 38, 20, 26)
	g.fillStyle = look.door
	g.fillRect(TEX / 2 - 8, 40, 16, 24)
	g.fillStyle = "rgba(255,255,255,.18)"
	g.fillRect(TEX / 2 - 6, 43, 12, 8)
	g.fillStyle = "#d9c15a"
	g.fillRect(TEX / 2 + 4, 52, 2, 2)
	// The letterbox. This is the whole reason anyone is on this street.
	g.fillStyle = "#3a2a20"
	g.fillRect(TEX / 2 - 5, 56, 10, 3)
	g.fillStyle = look.trim
	g.font = 'bold 7px "Arial Narrow", Arial, sans-serif'
	g.fillText(look.number, TEX / 2 + 12, 46)
	poom_grime(g, 37, 0.1, TEX, TEX)
	return c
}

/** A picket fence, with the gaps actually missing so you see the garden through it. */
function poom_tex_fence(sign) {
	var c = poom_canvas(TEX, TEX)
	var g = c.getContext("2d")
	// The texture is a full 64 tall but only the bottom third is ever drawn: a fence is
	// rendered as a short wall, and the render takes the strip it needs from the bottom.
	var top = 30
	g.fillStyle = "#efeae0"
	for (var i = 0; i < 8; i++) {
		var x = i * 8 + 1
		g.fillRect(x, top + 4, 6, TEX - top - 4)
		g.beginPath()
		g.moveTo(x, top + 5)
		g.lineTo(x + 3, top)
		g.lineTo(x + 6, top + 5)
		g.closePath()
		g.fill()
	}
	g.fillStyle = "#ddd6c8"
	g.fillRect(0, top + 12, TEX, 5)
	g.fillRect(0, top + 24, TEX, 5)
	g.fillStyle = "rgba(0,0,0,.18)"
	g.fillRect(0, TEX - 4, TEX, 4)
	if (sign) {
		g.fillStyle = "#e8dfc6"
		g.fillRect(6, top + 6, TEX - 12, 24)
		g.strokeStyle = "#3a2c1e"
		g.lineWidth = 1
		g.strokeRect(6.5, top + 6.5, TEX - 13, 23)
		g.fillStyle = "#2a1f14"
		g.textAlign = "center"
		g.textBaseline = "middle"
		var step = Math.min(8, 22 / sign.length)
		sign.forEach(function (line, i) {
			var size = 8
			g.font = "bold " + size + 'px "Arial Narrow", Arial, sans-serif'
			while (g.measureText(line).width > TEX - 18 && size > 4) {
				size -= 1
				g.font = "bold " + size + 'px "Arial Narrow", Arial, sans-serif'
			}
			g.fillText(line, TEX / 2, top + 18 - ((sign.length - 1) * step) / 2 + i * step)
		})
		g.textAlign = "left"
		g.textBaseline = "alphabetic"
	}
	return c
}

/** A tree, and a pillar box: the two things a street this shape needs to not read as a corridor. */
function poom_tex_tree() {
	var c = poom_canvas(TEX, TEX)
	var g = c.getContext("2d")
	g.fillStyle = "#5b3f2a"
	g.fillRect(TEX / 2 - 4, 34, 8, TEX - 34)
	var rand = poom_rand(53)
	for (var i = 0; i < 90; i++) {
		var r = 7 + rand() * 9
		var x = TEX / 2 + (rand() - 0.5) * 44
		var y = 20 + (rand() - 0.5) * 30
		var tone = 52 + Math.floor(rand() * 52)
		g.fillStyle = "rgb(" + Math.round(tone * 0.5) + "," + tone + "," + Math.round(tone * 0.4) + ")"
		g.beginPath()
		g.arc(x, y, r, 0, Math.PI * 2)
		g.fill()
	}
	return c
}
function poom_tex_pillar() {
	var c = poom_canvas(TEX, TEX)
	var g = c.getContext("2d")
	g.fillStyle = "#a51f1a"
	g.fillRect(TEX / 2 - 13, 18, 26, TEX - 18)
	g.fillStyle = "#8c1713"
	g.fillRect(TEX / 2 - 13, 18, 5, TEX - 18)
	g.beginPath()
	g.arc(TEX / 2, 20, 13, Math.PI, 0)
	g.fillStyle = "#b52521"
	g.fill()
	g.fillStyle = "#1a1210"
	g.fillRect(TEX / 2 - 9, 30, 18, 4)
	g.fillStyle = "#e8d48a"
	g.fillRect(TEX / 2 - 7, 40, 14, 8)
	return c
}

/* The sky: one wide strip, sampled by heading, so turning pans the clouds past you. */
var SKY_W = 512
var SKY_H = 96
function poom_tex_sky() {
	var c = poom_canvas(SKY_W, SKY_H)
	var g = c.getContext("2d")
	var grad = g.createLinearGradient(0, 0, 0, SKY_H)
	grad.addColorStop(0, "#2f6fb5")
	grad.addColorStop(0.55, "#7fb2dd")
	grad.addColorStop(1, "#cfe0e8")
	g.fillStyle = grad
	g.fillRect(0, 0, SKY_W, SKY_H)
	var rand = poom_rand(71)
	for (var i = 0; i < 26; i++) {
		var cx = rand() * SKY_W
		var cy = 8 + rand() * 52
		var scale = 0.6 + rand() * 1.5
		g.fillStyle = "rgba(255,255,255," + (0.4 + rand() * 0.5).toFixed(2) + ")"
		for (var puff = 0; puff < 6; puff++) {
			var px = cx + (puff - 2.5) * 7 * scale
			var py = cy + Math.sin(puff) * 3 * scale
			var r = (7 + rand() * 6) * scale
			// Twice, a strip apart: the sky wraps as you turn, and a cloud cut in half at the
			// seam is the one thing that gives away that the sky is 512 pixels wide.
			;[px, px - SKY_W, px + SKY_W].forEach(function (at) {
				g.beginPath()
				g.arc(at, py, r, 0, Math.PI * 2)
				g.fill()
			})
		}
	}
	// The sun, low and hazy, because this is a morning round.
	var sun = g.createRadialGradient(SKY_W * 0.72, 22, 4, SKY_W * 0.72, 22, 34)
	sun.addColorStop(0, "rgba(255,250,210,.95)")
	sun.addColorStop(1, "rgba(255,240,190,0)")
	g.fillStyle = sun
	g.fillRect(SKY_W * 0.72 - 40, 0, 80, 70)
	return c
}

/**
 * The spam, drawn as frames of one animation: an envelope whose flap lifts to show what it
 * has instead of a mouth. Closed across the street, wide open when it is on you.
 */
var POOM_FRAMES = 8
function poom_mob_frame(open) {
	var c = poom_canvas(TEX, TEX)
	var g = c.getContext("2d")
	var left = 7
	var right = TEX - 7
	var top = 18
	var bottom = TEX - 8
	var mid = (left + right) / 2

	g.fillStyle = "#e8e0cc"
	g.fillRect(left, top, right - left, bottom - top)
	g.strokeStyle = "#2b2119"
	g.lineWidth = 2
	g.strokeRect(left, top, right - left, bottom - top)
	g.fillStyle = "#2b2119"
	g.fillRect(left + 8, top + 22, 7, 4 + Math.round(open * 3))
	g.fillRect(right - 15, top + 22, 7, 4 + Math.round(open * 3))
	g.fillStyle = "#b8332a"
	g.fillRect(right - 17, top + 32, 11, 8)
	g.fillStyle = "#8d251d"
	g.fillRect(right - 17, top + 32, 11, 2)

	// The mouth, opening down into the body: a dark gap with a tooth on each jaw.
	var gape = open * 20
	if (gape > 1) {
		g.fillStyle = "#280b08"
		g.fillRect(left + 2, top + 2, right - left - 4, gape)
		g.fillStyle = "#f6f1e4"
		for (var t = 0; t < 5; t++) {
			var tx = left + 4 + t * ((right - left - 8) / 5)
			var w = (right - left - 8) / 5 - 2
			g.beginPath()
			g.moveTo(tx, top + 2)
			g.lineTo(tx + w, top + 2)
			g.lineTo(tx + w / 2, top + 2 + Math.min(6, gape * 0.4))
			g.closePath()
			g.fill()
			g.beginPath()
			g.moveTo(tx, top + 2 + gape)
			g.lineTo(tx + w, top + 2 + gape)
			g.lineTo(tx + w / 2, top + 2 + gape - Math.min(5, gape * 0.34))
			g.closePath()
			g.fill()
		}
	}
	// The flap, hinged along the top edge: shut it lies flat, open it rears back over the top.
	g.fillStyle = "#d8cfb6"
	g.beginPath()
	g.moveTo(left, top)
	g.lineTo(right, top)
	g.lineTo(mid, top + 22 - open * 40)
	g.closePath()
	g.fill()
	g.stroke()
	return c
}

/*
 * The shotgun, as pixel art rather than as shapes: 64x40 pixels, drawn once at boot and
 * blitted up whole. Canvas curves scaled into a 320-wide window come out as soft blobs —
 * this is the same trick the games it is impersonating used, which is to draw the thing at
 * the size it is actually stored and let the hardware make it big.
 *
 * Two frames: fore-end forward, and fore-end racked back after a shot.
 */
/*
 * The weapon frames come off the server as sprites (see inbox_poom.ts): at rest, firing,
 * and the pump going back and forward again. They are drawn for a 320-wide view and this
 * view is 320 wide, so they go on screen at their own size, a pixel to a pixel.
 */
/*
 * The ready pose is the one with the hand on the pump — Freedoom's "A" frame is the barrel
 * alone, which is the weapon lowered, so it is kept for the drop when you die and the cycle
 * runs fire → pump back → pump forward → ready.
 */
var POOM_GUN_FRAMES = ["gunidle", "gunfire", "gunpump", "gunload"]
var POOM_FLASH_FRAMES = ["flasha", "flashb"]
/* Where each frame sits: the sprites carry no offsets, so the muzzle is lined up here. */
var POOM_GUN_AT = {
	gunidle: { x: 4, y: 0 },
	gunfire: { x: 4, y: 0 },
	gunpump: { x: 6, y: 6 },
	gunload: { x: 12, y: 8 },
}
/* The mouth of the barrel, in the fired frame's own pixels: the flash is centred on it. */
var POOM_MUZZLE = { x: 52, y: 4 }

function poom_load_sprites() {
	var loaded = {}
	POOM_GUN_FRAMES.concat(POOM_FLASH_FRAMES).forEach(function (name) {
		var image = new Image()
		image.src = api + "/poom/" + name
		loaded[name] = image
	})
	return loaded
}

function poom_build_art() {
	if (poom_art) return
	poom_art = {
		ground: {},
		tall: {},
		short: {},
		props: {},
		mobs: [],
		sky: poom_tex_sky(),
		guns: poom_load_sprites(),
		houses: POOM_HOUSES.map(poom_tex_house),
	}
	poom_art.ground["."] = poom_tex_road()
	poom_art.ground[":"] = poom_tex_pavement()
	poom_art.ground[","] = poom_tex_grass()
	poom_art.tall["#"] = poom_tex_hedge()
	poom_art.short.f = poom_tex_fence(null)
	Object.keys(POOM_SIGNS).forEach(function (key) {
		poom_art.short[key] = poom_tex_fence(POOM_SIGNS[key])
	})
	poom_art.props.T = poom_tex_tree()
	poom_art.props.P = poom_tex_pillar()
	for (var i = 0; i < POOM_FRAMES; i++) poom_art.mobs.push(poom_mob_frame(i / (POOM_FRAMES - 1)))
	// The ground is sampled a pixel at a time by the floor caster, so it wants the raw
	// pixels rather than a canvas to blit.
	poom_art.pixels = {}
	Object.keys(poom_art.ground).forEach(function (key) {
		var g = poom_art.ground[key].getContext("2d")
		poom_art.pixels[key] = new Uint32Array(g.getImageData(0, 0, TEX, TEX).data.buffer)
	})
	var sky = poom_art.sky.getContext("2d")
	poom_art.sky_pixels = new Uint32Array(sky.getImageData(0, 0, SKY_W, SKY_H).data.buffer)
}

/** Which house this wall belongs to. Per building, not per wall, so a front stays one front. */
function poom_house(mx, my) {
	var id = (Math.floor(mx / 3) * 7 + Math.floor(my / 4) * 13) % POOM_HOUSES.length
	return poom_art.houses[id]
}

/* ---- The world ---- */

var POOM_SPAWNS = [
	{ x: 6.5, y: 9.5 }, { x: 9.5, y: 8.5 }, { x: 12.5, y: 10.5 }, { x: 15.5, y: 9.5 },
	{ x: 18.5, y: 8.5 }, { x: 21.5, y: 10.5 }, { x: 24.5, y: 9.5 }, { x: 27.5, y: 8.5 },
	{ x: 30.5, y: 10.5 }, { x: 33.5, y: 9.5 }, { x: 36.5, y: 8.5 }, { x: 39.5, y: 10.5 },
	{ x: 41.5, y: 9.5 }, { x: 34.5, y: 5.5 }, { x: 20.5, y: 5.5 }, { x: 11.5, y: 13.5 },
	{ x: 28.5, y: 13.5 }, { x: 38.5, y: 13.5 }, { x: 4.5, y: 5.5 }, { x: 7.5, y: 13.5 },
]

function poom_start() {
	poom_build_art()
	// One loop, ever. Restarting on top of a running one is how the whole game ended up
	// stepping twice per frame — every input twice as sensitive, everything twice as fast.
	cancelAnimationFrame(poom_frame)
	poom_frame = null
	poom_keys = {}
	poom = {
		x: 2.5, y: 9.5, dir: 0,
		vx: 0, vy: 0,
		health: 100, ammo: 40,
		hurt: 0, flash: 0, kick: 0, pitch: 0, bob: 0, walk: 0,
		note: "", note_at: 0,
		god: false,
		time: 0,
		spam: POOM_SPAWNS.map(function (spot) {
			return { x: spot.x, y: spot.y, dead: false, dying: 0, bite: 0, phase: spot.x + spot.y }
		}),
		over: null,
	}
	poom_loop()
}

var poom_last = 0
function poom_loop(now) {
	if (!poom) { poom_frame = null; return }
	poom_frame = requestAnimationFrame(poom_loop)
	var win = find("poom")
	// Minimised, no time passes: coming back to a corpse because the spam kept walking while
	// the window was down is the sort of thing that only ever reads as a bug.
	if (!win || !win.open || win.min) { poom_last = now || poom_last; return }
	var dt = Math.min(0.05, (now - poom_last) / 1000 || 0.016)
	poom_last = now
	poom.time += dt
	poom_step(dt)
	poom_draw()
}

function poom_step(dt) {
	var dead = !!poom.over
	poom.kick = Math.max(0, poom.kick - dt * 3.4)
	poom.flash = Math.max(0, poom.flash - dt * 5)
	poom.hurt = Math.max(0, poom.hurt - dt * 1.4)
	poom.pitch = poom.over === "dead"
		? Math.min(46, poom.pitch + dt * 90)
		: poom.pitch * 0.86 - poom.kick * 0.9

	if (!dead) {
		if (poom_keys.left) poom.dir -= 2.7 * dt
		if (poom_keys.right) poom.dir += 2.7 * dt
		var forward = (poom_keys.up ? 1 : 0) - (poom_keys.down ? 1 : 0)
		var strafe = (poom_keys.sright ? 1 : 0) - (poom_keys.sleft ? 1 : 0)
		// Accelerate into a wish direction and rub the rest off, rather than teleporting a
		// fixed step per frame: it gives the weight that made those games feel like something.
		var wish_x = Math.cos(poom.dir) * forward - Math.sin(poom.dir) * strafe
		var wish_y = Math.sin(poom.dir) * forward + Math.cos(poom.dir) * strafe
		var len = Math.hypot(wish_x, wish_y) || 1
		var pushing = forward || strafe ? 1 : 0
		poom.vx += (wish_x / len) * 26 * dt * pushing
		poom.vy += (wish_y / len) * 26 * dt * pushing
		var drag = Math.max(0, 1 - 9 * dt)
		poom.vx *= drag
		poom.vy *= drag
		var speed = Math.hypot(poom.vx, poom.vy)
		if (speed > 3.6) { poom.vx = (poom.vx / speed) * 3.6; poom.vy = (poom.vy / speed) * 3.6 }
		// Axis at a time, so a fence you brush along slides you instead of stopping you dead.
		// The margin is what keeps the camera off the wall, and the texture out of your eye.
		var pad = 0.28
		var step_x = poom.vx * dt
		var step_y = poom.vy * dt
		if (!poom_solid(poom.x + step_x + Math.sign(step_x) * pad, poom.y)) poom.x += step_x
		else poom.vx = 0
		if (!poom_solid(poom.x, poom.y + step_y + Math.sign(step_y) * pad)) poom.y += step_y
		else poom.vy = 0
		// The bob is the speed, not the button: let go and it settles instead of stopping dead.
		poom.walk += speed * dt * 3.4
		poom.bob = Math.sin(poom.walk * 2) * Math.min(2.6, speed * 0.9)
	} else {
		poom.vx *= 0.8
		poom.vy *= 0.8
		poom.bob *= 0.9
	}

	var alive = 0
	poom.spam.forEach(function (mob) {
		if (mob.dead) return
		if (mob.dying > 0) {
			mob.dying -= dt * 3.4
			if (mob.dying <= 0) mob.dead = true
			return
		}
		alive++
		mob.bite = Math.max(0, mob.bite - dt)
		if (dead) return
		var vx = poom.x - mob.x
		var vy = poom.y - mob.y
		var far = Math.hypot(vx, vy) || 1
		if (far < 0.85) {
			// A bite, not a leak: health that slides down by fractions is unreadable, so they
			// take a whole mouthful on a cooldown and the number visibly steps.
			if (mob.bite <= 0) {
				mob.bite = 0.7
				if (poom.god) return
				poom.health -= 13
				poom.hurt = 1
				poom_say("CHEWED ON")
				if (poom.health <= 0) { poom.health = 0; poom.over = "dead" }
			}
			return
		}
		var step = 1.15 * dt
		if (!poom_solid(mob.x + (vx / far) * step * 1.6, mob.y)) mob.x += (vx / far) * step
		if (!poom_solid(mob.x, mob.y + (vy / far) * step * 1.6)) mob.y += (vy / far) * step
	})
	if (!alive && !poom.over) { poom.over = "clear"; poom_say("INBOX ZERO") }
}

/** Doom put its pickups in the top-left corner, so that is where this says things too. */
function poom_say(text) {
	poom.note = text
	poom.note_at = poom.time
}

/** The shotgun: straight ahead, nothing else. Whatever is nearest in the middle of the screen. */
function poom_fire() {
	if (!poom || poom.over || poom.ammo <= 0) return
	poom.ammo--
	poom.flash = 1
	poom.kick = 1
	var best = null
	poom.spam.forEach(function (mob) {
		if (mob.dead || mob.dying > 0) return
		var vx = mob.x - poom.x
		var vy = mob.y - poom.y
		var far = Math.hypot(vx, vy)
		var off = Math.atan2(vy, vx) - poom.dir
		while (off > Math.PI) off -= Math.PI * 2
		while (off < -Math.PI) off += Math.PI * 2
		// Wider tolerance up close, the way a spread does.
		if (Math.abs(off) > 0.22 || far > 14) return
		if (!best || far < best.far) best = { mob: mob, far: far }
	})
	if (!best) return
	// No shooting through houses: walk the ray and see if it gets there. Fences are waist
	// height, so pellets go over them.
	var steps = Math.ceil(best.far * 8)
	for (var i = 1; i < steps; i++) {
		var t = (best.far * i) / steps
		if (poom_tall(poom.x + Math.cos(poom.dir) * t, poom.y + Math.sin(poom.dir) * t)) return
	}
	best.mob.dying = 1
	poom.ammo = Math.min(99, poom.ammo + 2)
	poom_say("MARKED AS SPAM")
}

/* ---- The renderer ---- */

var poom_buffer = null
/*
 * Sky and street, a pixel at a time, straight into an ImageData. Walls are strips of a
 * texture and can go through drawImage; the ground can't — it recedes, so every row of it
 * is a different slice of the world, which is the one thing a raycaster has to cast for.
 */
function poom_ground(ctx, horizon) {
	var canvas = ctx.canvas
	if (!poom_buffer || poom_buffer.width !== canvas.width) {
		poom_buffer = ctx.createImageData(POOM_W, POOM_H)
		poom_buffer.pixels = new Uint32Array(poom_buffer.data.buffer)
	}
	var out = poom_buffer.pixels
	var sky = poom_art.sky_pixels
	var cos = Math.cos(poom.dir)
	var sin = Math.sin(poom.dir)
	var fov = 0.66

	// Sky: the strip panned by heading, and squashed into whatever is above the horizon.
	var pan = Math.floor(((poom.dir / (Math.PI * 2)) % 1) * SKY_W + SKY_W) % SKY_W
	var sky_top = Math.max(0, Math.min(POOM_H, horizon))
	for (var y = 0; y < sky_top; y++) {
		var sy = Math.min(SKY_H - 1, Math.max(0, Math.floor(((y - horizon + POOM_H * 0.62) / (POOM_H * 0.62)) * SKY_H)))
		var row = sy * SKY_W
		var out_row = y * POOM_W
		for (var x = 0; x < POOM_W; x++) {
			out[out_row + x] = sky[row + ((pan + Math.floor(x * 0.62)) % SKY_W)]
		}
	}

	// Ground: one distance per row, then step across it. The eye is half a storey up, which
	// is where the 0.5 comes from.
	var rx0 = cos + sin * fov
	var ry0 = sin - cos * fov
	var rx1 = cos - sin * fov
	var ry1 = sin + cos * fov
	for (var gy = Math.max(0, sky_top); gy < POOM_H; gy++) {
		var p = gy - horizon
		if (p <= 0) continue
		var dist = (0.5 * POOM_H) / p
		var step_x = (dist * (rx1 - rx0)) / POOM_W
		var step_y = (dist * (ry1 - ry0)) / POOM_W
		var wx = poom.x + dist * rx0
		var wy = poom.y + dist * ry0
		// Fog: the far end of the road fades into the haze rather than staying crisp to the
		// hedge, which is what gives a flat street any depth at all.
		var fog = Math.min(0.72, Math.max(0, (dist - 3.5) / 13))
		var out_row2 = gy * POOM_W
		for (var gx = 0; gx < POOM_W; gx++) {
			var cell = poom_cell(wx, wy)
			var tex = poom_art.pixels[cell] || poom_art.pixels[","]
			var tx = (wx - Math.floor(wx)) * TEX
			var ty = (wy - Math.floor(wy)) * TEX
			var px = tex[(ty | 0) * TEX + (tx | 0)]
			if (fog > 0.01) {
				// Blend toward the haze in place, one channel at a time.
				var r = px & 255
				var g2 = (px >> 8) & 255
				var b = (px >> 16) & 255
				r += (198 - r) * fog
				g2 += (214 - g2) * fog
				b += (226 - b) * fog
				px = 0xff000000 | (b << 16) | (g2 << 8) | r
			}
			out[out_row2 + gx] = px
			wx += step_x
			wy += step_y
		}
	}
	ctx.putImageData(poom_buffer, 0, 0)
}

function poom_draw() {
	var canvas = $("poom-view")
	var ctx = canvas.getContext("2d")
	var zbuf = new Array(POOM_W)
	var horizon = Math.round(POOM_H / 2 + poom.pitch + poom.bob)

	poom_ground(ctx, horizon)

	var fov = 0.66
	for (var col = 0; col < POOM_W; col++) {
		var camera = (2 * col) / POOM_W - 1
		var rx = Math.cos(poom.dir) - Math.sin(poom.dir) * fov * camera
		var ry = Math.sin(poom.dir) + Math.cos(poom.dir) * fov * camera
		var mx = Math.floor(poom.x)
		var my = Math.floor(poom.y)
		var dx = Math.abs(1 / (rx || 1e-6))
		var dy = Math.abs(1 / (ry || 1e-6))
		var sx = rx < 0 ? -1 : 1
		var sy = ry < 0 ? -1 : 1
		var tx = rx < 0 ? (poom.x - mx) * dx : (mx + 1 - poom.x) * dx
		var ty = ry < 0 ? (poom.y - my) * dy : (my + 1 - poom.y) * dy
		var side = 0
		var fences = []
		// Step until a house or a hedge stops the ray, keeping every fence it passed on the
		// way: you see over a fence, so it can't end the cast, but it still has to be drawn.
		for (var guard = 0; guard < 96; guard++) {
			if (tx < ty) { tx += dx; mx += sx; side = 0 }
			else { ty += dy; my += sy; side = 1 }
			var cell = poom_cell(mx, my)
			if (POOM_TALL.indexOf(cell) !== -1) break
			if (POOM_SHORT.indexOf(cell) !== -1) {
				fences.push({ cell: cell, dist: side === 0 ? tx - dx : ty - dy, side: side, rx: rx, ry: ry })
			}
		}
		var dist = side === 0 ? tx - dx : ty - dy
		if (dist < 0.02) dist = 0.02
		zbuf[col] = dist
		var art = poom_cell(mx, my) === "#" ? poom_art.tall["#"] : poom_house(mx, my)
		poom_strip(ctx, art, col, dist, side, rx, ry, horizon, 1)
		// Fences after the wall behind them, far to near, so the near one wins.
		fences.sort(function (a, b) { return b.dist - a.dist })
		fences.forEach(function (fence) {
			poom_strip(ctx, poom_art.short[fence.cell], col, fence.dist, fence.side, rx, ry, horizon, 0.44)
		})
	}

	// The spam and the street furniture, furthest first, sliced against the wall distances.
	var seen = poom.spam
		.filter(function (mob) { return !mob.dead })
		.map(function (mob) { return { x: mob.x, y: mob.y, mob: mob } })
	POOM_MAP.forEach(function (row, my2) {
		for (var mx2 = 0; mx2 < row.length; mx2++) {
			if (POOM_PROP.indexOf(row[mx2]) !== -1) seen.push({ x: mx2 + 0.5, y: my2 + 0.5, prop: row[mx2] })
		}
	})
	seen
		.map(function (thing) {
			thing.vx = thing.x - poom.x
			thing.vy = thing.y - poom.y
			thing.far = Math.hypot(thing.vx, thing.vy)
			return thing
		})
		.sort(function (a, b) { return b.far - a.far })
		.forEach(function (thing) {
			if (thing.far > 22) return
			var off = Math.atan2(thing.vy, thing.vx) - poom.dir
			while (off > Math.PI) off -= Math.PI * 2
			while (off < -Math.PI) off += Math.PI * 2
			if (Math.abs(off) > 1.05 || thing.far < 0.12) return
			var depth = Math.cos(off) * thing.far
			if (depth < 0.14) return
			var mob = thing.mob
			var dying = mob && mob.dying > 0
			var scale = thing.prop === "T" ? 1.7 : 1
			var size = Math.min(POOM_H * 6, (POOM_H / depth) * scale) * (dying ? Math.max(0.2, mob.dying) : 1)
			var centre = POOM_W2 + Math.tan(off) * (POOM_W2 / fov)
			// Everything stands on the ground, so the feet go where a wall's foot would.
			var foot = horizon + POOM_H / depth / 2
			var top = foot - size
			var left = Math.round(centre - size / 2)
			var frame
			if (mob) {
				// It chews faster the closer it gets, and it is wide open by the time it arrives.
				var mouth = dying
					? POOM_FRAMES - 1
					: Math.floor(
						(Math.sin(poom.time * (2.5 + 6 / Math.max(1, depth)) + mob.phase) * 0.5 + 0.5) *
							(POOM_FRAMES - 1) * Math.min(1, 2.4 / Math.max(1, depth - 0.3))
					)
				frame = poom_art.mobs[Math.max(0, Math.min(POOM_FRAMES - 1, mouth))]
			} else frame = poom_art.props[thing.prop]
			var haze = Math.min(0.72, Math.max(0, (depth - 3.5) / 13))
			ctx.globalAlpha = dying ? Math.max(0, mob.dying) : 1
			for (var s = 0; s < size; s++) {
				var col2 = left + s
				if (col2 < 0 || col2 >= POOM_W || zbuf[col2] < depth) continue
				ctx.drawImage(frame, (s / size) * TEX, 0, TEX / size, TEX, col2, top, 1, size)
				if (haze > 0.01) {
					ctx.fillStyle = "rgba(198,214,226," + haze.toFixed(3) + ")"
					ctx.fillRect(col2, top, 1, size)
				}
			}
			ctx.globalAlpha = 1
		})

	poom_gun(ctx, horizon)

	// Being bitten: the whole screen goes red from the edges in, the way it did.
	if (poom.hurt > 0) {
		var wash = ctx.createRadialGradient(POOM_W2, POOM_H / 2, POOM_H * 0.2, POOM_W2, POOM_H / 2, POOM_W * 0.72)
		wash.addColorStop(0, "rgba(190,20,12," + (0.22 * poom.hurt).toFixed(3) + ")")
		wash.addColorStop(1, "rgba(140,0,0," + (0.88 * poom.hurt).toFixed(3) + ")")
		ctx.fillStyle = wash
		ctx.fillRect(0, 0, POOM_W, POOM_H)
	}
	if (poom.flash > 0.55) {
		ctx.fillStyle = "rgba(255,238,180," + (0.3 * (poom.flash - 0.55)).toFixed(3) + ")"
		ctx.fillRect(0, 0, POOM_W, POOM_H)
	}

	if (poom.note && poom.time - poom.note_at < 2) {
		ctx.fillStyle = "rgba(255,250,235," + Math.min(1, (2 - (poom.time - poom.note_at)) * 1.4).toFixed(2) + ")"
		ctx.font = 'bold 11px "Courier New", monospace'
		ctx.fillText(poom.note, 6, 15)
	}
	if (poom.over) {
		ctx.fillStyle = "rgba(0,0,0,.6)"
		ctx.fillRect(0, POOM_H / 2 - 28, POOM_W, 56)
		ctx.fillStyle = poom.over === "clear" ? "#ffd35c" : "#ff6a5c"
		ctx.font = 'bold 19px "Courier New", monospace'
		ctx.textAlign = "center"
		ctx.fillText(poom.over === "clear" ? "ROUND FINISHED" : "YOU GOT SPAMMED", POOM_W2, POOM_H / 2)
		ctx.fillStyle = "#e8e2d4"
		ctx.font = 'bold 11px "Courier New", monospace'
		ctx.fillText("Enter or click: play again", POOM_W2, POOM_H / 2 + 20)
		ctx.textAlign = "left"
	}
	poom_hud()
}

/**
 * One vertical strip of one wall. The height is how much of a storey it stands: a house
 * is the whole one, a fence a little under half, both standing on the same ground line.
 */
function poom_strip(ctx, art, col, dist, side, rx, ry, horizon, height) {
	if (dist < 0.02) dist = 0.02
	var full = POOM_H / dist
	var foot = horizon + full / 2
	var tall = full * height
	// Where along the wall this column landed, which is the column of the texture to use.
	var wall = side === 0 ? poom.y + dist * ry : poom.x + dist * rx
	wall -= Math.floor(wall)
	var tex_x = Math.floor(wall * TEX)
	// Two of the four faces are seen from behind, in texture terms, and have to be flipped
	// or every sign on this street reads back to front.
	if ((side === 0 && rx < 0) || (side === 1 && ry > 0)) tex_x = TEX - tex_x - 1
	// Take only the part of the texture this strip stands for — scaling the whole 64 rows
	// into a short strip is what smears a fence into a stripe.
	var src_y = TEX - TEX * height
	ctx.drawImage(art, tex_x, src_y, 1, TEX - src_y, col, foot - tall, 1, tall)
	// Distance and facing, as one wash over the strip: haze, not black — it is daylight.
	var haze = Math.min(0.72, Math.max(0, (dist - 3.5) / 13))
	var dark = side ? 0.14 : 0
	if (haze > 0.01) {
		ctx.fillStyle = "rgba(198,214,226," + haze.toFixed(3) + ")"
		ctx.fillRect(col, foot - tall, 1, tall)
	}
	if (dark) {
		ctx.fillStyle = "rgba(20,26,40,.14)"
		ctx.fillRect(col, foot - tall, 1, tall)
	}
}

/*
 * The weapon. One sprite, picked by where the recoil has got to: the shot, then the pump
 * back, then the pump coming forward, then at rest again — which is the whole animation
 * that weapon ever had. It sways with the walk and drops with the kick.
 */
function poom_gun(ctx, horizon) {
	var sway = Math.sin(poom.walk) * 5
	var lift = Math.abs(Math.cos(poom.walk)) * 4
	var drop = poom.kick * 26 + (poom.over === "dead" ? 130 : 0)
	var stage = poom.kick > 0.72 ? 1 : poom.kick > 0.42 ? 2 : poom.kick > 0.12 ? 3 : 0
	var name = poom.over === "dead" ? "gunidle" : POOM_GUN_FRAMES[stage]
	var art = poom_art.guns[name]
	// Nothing to draw until the sprite has actually arrived over the wire.
	if (!art || !art.complete || !art.naturalWidth) return
	var at = POOM_GUN_AT[name]
	var x = Math.round(POOM_W2 - art.naturalWidth / 2 + at.x + sway)
	var y = Math.round(POOM_H - art.naturalHeight + at.y + drop + lift - (horizon - POOM_H / 2) * 0.25)

	ctx.imageSmoothingEnabled = false
	// The flash goes off the end of the barrel, so it is drawn first and the gun over it.
	if (poom.flash > 0.45) {
		var flash = poom_art.guns[POOM_FLASH_FRAMES[poom.flash > 0.72 ? 0 : 1]]
		if (flash && flash.complete && flash.naturalWidth) {
			ctx.drawImage(
				flash,
				Math.round(x + POOM_MUZZLE.x - flash.naturalWidth / 2),
				Math.round(y + POOM_MUZZLE.y - flash.naturalHeight / 2)
			)
		}
	}
	ctx.drawImage(art, x, y)
	ctx.imageSmoothingEnabled = true
}

/*
 * The status bar. The face is the Postboi mark, and it is the health bar you actually read:
 * it goes nervous the moment something bites, and it gives up entirely near zero.
 */
function poom_hud() {
	$("poom-health").textContent = Math.ceil(poom.health) + "%"
	$("poom-ammo").textContent = poom.ammo
	$("poom-spam").textContent = poom.spam.filter(function (mob) { return !mob.dead }).length
	// In order of what matters most: how it ended, then whether anything can hurt you,
	// then how much of you is left.
	var mood = "ok"
	if (poom.over === "dead") mood = "dead"
	else if (poom.over === "clear") mood = "won"
	else if (poom.god) mood = "god"
	else if (poom.health <= 34) mood = "low"
	else if (poom.hurt > 0.15) mood = "hurt"
	// A blink, off the same clock the game runs on: every five seconds, for a fifth of one.
	// Only the two faces that have one to blink with — a wince does not wink.
	if (poom.time % 5 < 0.2) {
		if (mood === "ok") mood = "wink"
		else if (mood === "god") mood = "godwink"
	}
	$("poom-faces").className = "face-" + mood + (poom.hurt > 0.5 && !poom.god ? " hit" : "")
}

var POOM_KEYS = {
	ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
	w: "up", s: "down", a: "sleft", d: "sright", q: "left", e: "right",
}
/*
 * The cheat. Typed, not pressed: the letters are collected as they come and the tail of
 * what you have typed is checked against the code, so it fires the moment the last D lands
 * and nothing has to be cleared first. It is the one from 1993 because it is the only one
 * anybody remembers.
 */
var POOM_TYPED = ""
function poom_cheat(key) {
	if (key.length !== 1) return false
	POOM_TYPED = (POOM_TYPED + key.toLowerCase()).slice(-8)
	if (POOM_TYPED.slice(-5) !== "iddqd") return false
	POOM_TYPED = ""
	poom.god = !poom.god
	poom.health = poom.god ? 100 : poom.health
	poom_say(poom.god ? "GOD MODE ON. NOBODY DELIVERS LIKE YOU" : "GOD MODE OFF")
	return true
}

document.addEventListener("keydown", function (event) {
	if (focused !== "poom" || !poom) return
	if (poom_cheat(event.key)) return
	if (event.key === "Enter" && poom.over) { event.preventDefault(); return poom_start() }
	if (event.key === " ") { event.preventDefault(); return poom_fire() }
	var name = POOM_KEYS[event.key]
	if (!name) return
	event.preventDefault()
	poom_keys[name] = true
})
document.addEventListener("keyup", function (event) {
	var name = POOM_KEYS[event.key]
	if (name) poom_keys[name] = false
})
// Keys held when the window loses the focus would otherwise stay held for ever.
window.addEventListener("blur", function () { poom_keys = {} })
/* Click to shoot, drag to look — the mouse this thing was played with had two jobs. */
$("poom-view").addEventListener("mousedown", function (event) {
	if (poom && poom.over) return poom_start()
	poom_fire()
	var from = event.clientX
	track(function (moved) {
		if (!poom) return
		poom.dir += (moved.clientX - from) * 0.006
		from = moved.clientX
	})
})

function poom_open() {
	ensure_signed_on()
	open_window("poom")
	if (!poom) return poom_start()
	if (!poom_frame) poom_loop()
}

/*
 * The voice. Muted state is remembered, and defaults to whatever the server was configured
 * with — a shared machine or a pairing session is exactly where an unexpected "Welcome!"
 * is least welcome.
 */
var muted = localStorage.getItem("postboi:sound")
	? localStorage.getItem("postboi:sound") === "off"
	: document.documentElement.dataset.sounds === "off"

/*
 * Browsers refuse audio until the page has been interacted with, and a freshly-opened
 * inbox has had none — so the greeting would simply never be heard. A blocked clip is
 * held and released by the first click or keypress instead of being dropped.
 */
var pending = null
function play(name) {
	if (muted) return null
	var audio = new Audio(api + "/sounds/" + name)
	audio.volume = 0.7
	var played = audio.play()
	if (played && played.catch) {
		played.catch(function () {
			pending = audio
		})
	}
	return audio
}

function release_pending() {
	if (!pending || muted) return
	var audio = pending
	pending = null
	audio.play().catch(function () {})
}
document.addEventListener("pointerdown", release_pending, true)
document.addEventListener("keydown", release_pending, true)

/** The handshake, held open for as long as the sign-on takes. */
var dialing = null
function stop_dialing() {
	if (!dialing) return
	dialing.pause()
	dialing = null
}

function apply_mute(on) {
	muted = on
	if (on) stop_dialing()
	var button = $("t-sound")
	button.className = on ? "tb" : "tb on"
	button.firstChild.textContent = on ? "\\u{1F507}" : "\\u{1F50A}"
	button.lastChild.nodeValue = on ? "Muted" : "Sound"
}


/* ---- Window manager ---- */
var wins = []
var z = 20
var focused = null

/** Re-place both child windows after the desktop changes size. */
function relayout() {
	var box = ws_rect()
	wins.forEach(function (win) {
		var el = win.el
		// Size first, then position — clamping them independently can still leave a window
		// hanging off the bottom, because its top was fine and its height was fine separately.
		var w = Math.min(win.size.w, box.w - 16)
		var h = Math.min(win.size.h, box.h - 16)
		el.style.width = w + "px"
		el.style.height = h + "px"
		if (win.placed) {
			// Moved or resized by hand: keep it where it was put, just inside the frame.
			el.style.left = Math.max(0, Math.min(el.offsetLeft, box.w - w)) + "px"
			el.style.top = Math.max(0, Math.min(el.offsetTop, box.h - h)) + "px"
		} else {
			el.style.left = Math.round((box.w - w) / 2) + "px"
			el.style.top = Math.round((box.h - h) / 2) + "px"
		}
	})
}

/*
 * The area a window may occupy: the desktop, less the taskbar. The mail windows are the
 * desktop's own, not the app's — minimising Postboi Local leaves them exactly where they were,
 * and the taskbar brings any one of them back on its own.
 */
function ws_rect() {
	var screen = $("screen")
	return { w: screen.clientWidth, h: screen.clientHeight - 30 }
}

function place(el, r) {
	el.style.left = r.x + "px"
	el.style.top = r.y + "px"
	el.style.width = r.w + "px"
	el.style.height = r.h + "px"
}

function register(id, title, rect) {
	var el = $(id)
	var win = {
		id: id,
		el: el,
		title: title,
		restore: null,
		min: false,
		open: id === "mailbox",
		// The size it wants, and whether the user has taken charge of where it sits. Until
		// they have, it re-centres whenever the app window changes size.
		size: { w: rect.w, h: rect.h },
		placed: false,
	}
	wins.push(win)
	place(el, rect)

	el.addEventListener("mousedown", function () { focus_window(id) })
	// The Pokia has no XP chrome — no title bar to drag, no edges to pull — so each piece
	// is wired only where it exists. Its own drag handle is registered by the phone code.
	var bar = el.querySelector(".title-bar")
	if (bar) {
		bar.addEventListener("mousedown", function (event) {
			if (event.target.dataset && event.target.dataset.act) return
			drag(win, event)
		})
		bar.addEventListener("dblclick", function (event) {
			if (event.target.dataset && event.target.dataset.act) return
			toggle_max(win)
		})
		bar.addEventListener("click", function (event) {
			var act = event.target.dataset && event.target.dataset.act
			if (act === "max") toggle_max(win)
			if (act === "min") { win.min = true; el.classList.add("min"); paint() }
			if (act === "close") close_window(win)
		})
	}
	var grip = el.querySelector(".grip")
	if (grip) {
		grip.addEventListener("mousedown", function (e) { resize(win, e, true, true) })
		el.querySelector(".edge-r").addEventListener("mousedown", function (e) { resize(win, e, true, false) })
		el.querySelector(".edge-b").addEventListener("mousedown", function (e) { resize(win, e, false, true) })
	}
	return win
}

function find(id) {
	return wins.filter(function (w) { return w.id === id })[0]
}

/** Raise the app above the mail windows. It shares their stack; it does not contain them. */
var app_focused = true
/*
 * Focus the app without raising it. It keeps its fixed place at the bottom of the stack: the
 * mail windows are always in front of it, so clicking the frame can never bury the message
 * you were reading behind a maximised application window.
 */
function focus_app() {
	app_focused = true
	focused = null
	paint()
}

function focus_window(id) {
	var win = find(id)
	if (!win || !win.open) return
	app_focused = false
	win.min = false
	win.el.classList.remove("min")
	win.el.style.zIndex = ++z
	focused = id
	paint()
}

function toggle_max(win) {
	var box = ws_rect()
	if (win.restore) {
		place(win.el, win.restore)
		win.restore = null
		win.el.classList.remove("max")
	} else {
		win.restore = {
			x: win.el.offsetLeft,
			y: win.el.offsetTop,
			w: win.el.offsetWidth,
			h: win.el.offsetHeight,
		}
		place(win.el, { x: 0, y: 0, w: box.w, h: box.h })
		win.el.classList.add("max")
	}
	focus_window(win.id)
}

function close_window(win) {
	win.open = false
	// The reader's visibility is driven by whether a message is selected, so closing it is
	// really deselecting; the mailbox just goes away and is reopened from the Start menu.
	if (win.id === "reader") {
		current = null
		render_list()
		render_reader()
		return
	}
	// Same deal for the messenger and the channel windows: closing one is leaving its
	// conversation, and the state variable drives the visibility.
	if (win.id === "messenger") {
		convo = null
		render_list()
		render_messenger()
		return
	}
	if (win.id === "alertwin") {
		win.el.classList.add("closed")
		paint()
		return
	}
	if (win.id === "shotwin") {
		win.el.classList.add("closed")
		shot_list = []
		shot_msg = null
		paint()
		return
	}
	if (win.id === "wawin") {
		wa_convo = null
		render_list()
		render_wa()
		return
	}
	if (win.id === "platwin") {
		plat_convo = null
		render_list()
		render_plat()
		return
	}
	if (win.id === "pushwin") {
		push_open = false
		render_list()
		render_push()
		return
	}
	if (win.id === "pokia") {
		nk_open = false
		nk_current = null
		// A game left ticking behind a closed phone is a timer nobody can see or stop.
		clearTimeout(snake_timer)
		snake = null
		nk_view = "list"
		render_list()
		render_pokia()
		return
	}
	if (win.id === "poom") {
		cancelAnimationFrame(poom_frame)
		poom_frame = null
		poom = null
	}
	win.el.classList.add("closed")
	if (focused === win.id) focused = null
	paint()
	sync_actions()
}

/** Bring a closed or minimised window back — how the mailbox returns once it's shut. */
function open_window(id) {
	var win = find(id)
	if (!win) return
	win.open = true
	win.min = false
	win.el.classList.remove("closed", "min")
	focus_window(id)
	sync_actions()
}

/** Repaint what depends on window state: title-bar focus and the taskbar buttons. */
function paint() {
	var tasks = $("tasks")
	tasks.innerHTML = ""
	wins.forEach(function (win) {
		var bar = win.el.querySelector(".title-bar")
		if (bar) bar.className = "title-bar" + (focused === win.id && !win.min ? "" : " dim")
		if (!win.open) return
		var button = document.createElement("button")
		button.className = "task" + (focused === win.id && !win.min ? " on" : "")
		button.innerHTML = '<img class="mark" src="' + FAVICON_URL + '" alt="">'
		button.appendChild(document.createTextNode(win.title))
		button.onclick = function () {
			ensure_signed_on()
			// Clicking the focused window's button minimises it, as the real taskbar did.
			if (focused === win.id && !win.min) {
				win.min = true
				win.el.classList.add("min")
				focused = null
				paint()
			} else focus_window(win.id)
		}
		tasks.appendChild(button)
	})
	app_paint()
}

/** Shared pointer loop for both dragging and resizing — same maths, different target. */
function track(on_move) {
	document.body.classList.add("dragging")
	function move(event) { on_move(event) }
	function up() {
		document.body.classList.remove("dragging")
		document.removeEventListener("mousemove", move)
		document.removeEventListener("mouseup", up)
	}
	document.addEventListener("mousemove", move)
	document.addEventListener("mouseup", up)
}

function drag(win, event) {
	if (win.restore) return
	event.preventDefault()
	focus_window(win.id)
	win.placed = true
	var dx = event.clientX - win.el.offsetLeft
	var dy = event.clientY - win.el.offsetTop
	var box = ws_rect()
	track(function (e) {
		// Clamped so a window can never be dragged somewhere its title bar can't be grabbed back.
		var x = Math.max(-win.el.offsetWidth + 90, Math.min(box.w - 60, e.clientX - dx))
		var y = Math.max(0, Math.min(box.h - 24, e.clientY - dy))
		win.el.style.left = x + "px"
		win.el.style.top = y + "px"
	})
}

/**
 * Dragging for a dialog that isn't in the window list — the sign-on, which has no taskbar
 * button and nothing to raise above, but should still be shovable out of the way.
 */
function drag_dialog(el, host_el) {
	var bar = el.querySelector(".title-bar")
	if (bar.dataset.draggable) return
	bar.dataset.draggable = "1"
	bar.style.cursor = "default"
	bar.addEventListener("mousedown", function (event) {
		if (event.target.dataset && event.target.dataset.act) return
		event.preventDefault()
		var rect = el.getBoundingClientRect()
		// It's centred by flex until it's touched; pin it before the first move so it doesn't
		// jump out from under the cursor.
		el.style.position = "absolute"
		el.style.margin = "0"
		var host = (host_el || el.parentNode).getBoundingClientRect()
		var dx = event.clientX - rect.left
		var dy = event.clientY - rect.top
		el.style.left = rect.left - host.left + "px"
		el.style.top = rect.top - host.top + "px"
		track(function (e) {
			el.style.left = e.clientX - dx - host.left + "px"
			el.style.top = e.clientY - dy - host.top + "px"
		})
	})
}

function resize(win, event, horizontal, vertical) {
	if (win.restore) return
	event.preventDefault()
	event.stopPropagation()
	focus_window(win.id)
	win.placed = true
	var x0 = event.clientX
	var y0 = event.clientY
	var w0 = win.el.offsetWidth
	var h0 = win.el.offsetHeight
	track(function (e) {
		if (horizontal) win.el.style.width = Math.max(320, w0 + e.clientX - x0) + "px"
		if (vertical) win.el.style.height = Math.max(140, h0 + e.clientY - y0) + "px"
		win.size = { w: win.el.offsetWidth, h: win.el.offsetHeight }
	})
}

/** Resizing for the app window, which isn't in the window list and so can't share resize(). */
function resize_app(event, horizontal, vertical) {
	if (app_maximised) return
	event.preventDefault()
	event.stopPropagation()
	var el = $("aol")
	var x0 = event.clientX
	var y0 = event.clientY
	var w0 = el.offsetWidth
	var h0 = el.offsetHeight
	var box = ws_rect()
	track(function (e) {
		if (horizontal) {
			el.style.width = Math.max(420, Math.min(box.w - el.offsetLeft, w0 + e.clientX - x0)) + "px"
		}
		if (vertical) {
			el.style.height = Math.max(220, Math.min(box.h - el.offsetTop, h0 + e.clientY - y0)) + "px"
		}
	})
}

/* ---- The application window itself ---- */

/*
 * Maximised by default, like a mail client on a small screen, but restorable to a floating
 * window you can drag. It isn't in the window list — it's the frame the others live inside,
 * so it manages its own state and only borrows the taskbar.
 */
var app_restore = null
var app_maximised = true

/*
 * Minimising the frame takes the mail windows down with it, and restoring brings back exactly
 * the ones that were up. They are still independent — closing one, or minimising one on its
 * own, leaves the rest alone — but "show me the desktop" has to mean the whole desktop, or
 * minimising just puts a hole in the middle of a pile of windows.
 */
var stashed = []
function app_set(state) {
	var el = $("aol")
	if (state === "min" || state === "closed") {
		if (state === "min" && !el.classList.contains("min")) {
			stashed = wins
				.filter(function (win) { return win.open && !win.min })
				.map(function (win) {
					win.min = true
					win.el.classList.add("min")
					return win.id
				})
			focused = null
		}
		el.classList.add(state)
		// Both ways of getting to the desktop are a reveal: minimising it and closing it.
		run_bliss()
		paint()
		return
	}
	if (el.classList.contains("min")) {
		stashed.forEach(function (id) {
			var win = find(id)
			if (!win || !win.open) return
			win.min = false
			win.el.classList.remove("min")
		})
		stashed = []
	}
	el.classList.remove("min", "closed")
	paint()
}

/*
 * The wallpaper's postman. He starts on the frame already showing — the wallpaper is that
 * frame — so there is no cut when he sets off, and he holds wherever he finishes. He runs
 * again on every reveal: the desktop coming back is the gag, and a gag that fires once is
 * one nobody who wasn't watching the first time ever sees.
 */
function run_bliss() {
	if (!bliss_ready) return
	var video = $("bliss")
	video.className = "showing"
	video.currentTime = 0
	var playing = video.play()
	// Blocked autoplay just means no clip; the wallpaper behind it is the same opening frame.
	if (playing && playing.catch) playing.catch(function () { video.className = "" })
}

/*
 * Quitting Postboi Local. Its windows are the desktop's, not its own, so it has to take them
 * with it deliberately — an application that closes and leaves its documents open is a bug.
 * The shortcut on the desktop is how it comes back.
 */
function app_close() {
	play("goodbye")
	wins.forEach(function (win) {
		if (win.open) close_window(win)
	})
	app_set("closed")
}

/* The stop error, for turning the computer off. Any key or click restarts it, as ever. */
function app_crash() {
	set_pop(null)
	set_menu(false)
	$("bsod").className = "open"
}
function restart() {
	if ($("bsod").className === "open") location.reload()
}
$("bsod").onclick = restart

function app_toggle_max() {
	var el = $("aol")
	// Tracked with a flag, not the truthiness of the saved styles: a maximised window has no
	// inline styles at all, so the saved string is empty and a truthiness check never fires.
	if (!app_maximised) {
		el.style.cssText = app_restore || ""
		app_restore = null
		app_maximised = true
	} else {
		app_restore = el.style.cssText
		app_maximised = false
		var host = $("screen").getBoundingClientRect()
		var w = Math.round(host.width * 0.78)
		var h = Math.round((host.height - 30) * 0.8)
		el.style.left = Math.round((host.width - w) / 2) + "px"
		el.style.top = Math.round((host.height - 30 - h) / 2) + "px"
		el.style.right = "auto"
		el.style.bottom = "auto"
		el.style.width = w + "px"
		el.style.height = h + "px"
		drag_dialog(el, $("screen"))
	}
	el.classList.toggle("maxed", app_maximised)
	var button = el.querySelector('[data-app="max"]')
	button.setAttribute("aria-label", app_maximised ? "Restore" : "Maximize")
	app_set("open")
}

/** The app's own taskbar button, kept alongside the mail windows' ones. */
function app_paint() {
	var el = $("aol")
	var hidden = el.classList.contains("min") || el.classList.contains("closed")
	var button = $("app-task")
	button.style.display = el.classList.contains("closed") ? "none" : ""
	button.className = "task" + (!hidden && app_focused ? " on" : "")
	// The frame fades with everything else when a mail window has the focus. It is in the same
	// stack as they are, so it should look like it.
	el.querySelector(".title-bar").className = "title-bar" + (app_focused ? "" : " dim")
	if (hidden) set_menu(false)
}

$("aol").addEventListener("mousedown", function () { focus_app() })
$("aol").querySelector(".grip").addEventListener("mousedown", function (e) { resize_app(e, true, true) })
$("aol").querySelector(".edge-r").addEventListener("mousedown", function (e) { resize_app(e, true, false) })
$("aol").querySelector(".edge-b").addEventListener("mousedown", function (e) { resize_app(e, false, true) })
$("aol").querySelector(".title-bar-controls").addEventListener("click", function (event) {
	var act = event.target.dataset && event.target.dataset.app
	if (act === "min") app_set("min")
	if (act === "max") app_toggle_max()
	if (act === "close") app_close()
})
$("aol").querySelector(".title-bar").addEventListener("dblclick", function (event) {
	if (event.target.dataset && event.target.dataset.app) return
	app_toggle_max()
})
$("app-task").onclick = function () {
	ensure_signed_on()
	var el = $("aol")
	// Same rule as every other taskbar button: click the one in front and it goes away.
	if (el.classList.contains("min") || !app_focused) { app_set("open"); focus_app() }
	else app_set("min")
}

/* ---- Menus ---- */
var open_menu = null
function set_pop(name) {
	;["file", "window", "help"].forEach(function (m) {
		$("menu-" + m).className = "menu-pop" + (m === name ? " open" : "")
	})
	Array.prototype.forEach.call($("menubar").querySelectorAll("[data-menu]"), function (el) {
		el.className = el.dataset.menu === name ? "on" : ""
		// Under its own label rather than at a hardcoded offset, so it lines up whatever the
		// labels say.
		if (el.dataset.menu === name) $("menu-" + name).style.left = el.offsetLeft + "px"
	})
	open_menu = name
}
$("menubar").addEventListener("click", function (event) {
	event.stopPropagation()
	var name = event.target.dataset && event.target.dataset.menu
	if (name) return set_pop(open_menu === name ? null : name)
	var act = event.target.dataset && event.target.dataset.do
	if (!act) return
	set_pop(null)
	if (act === "mailbox") open_window("mailbox")
	if (act === "check") { open_window("mailbox"); load() }
	if (act === "print") window.print()
	if (act === "docs") window.open("https://docs.postboi.app/dev-inbox", "_blank", "noopener")
	if (act === "restore") app_set("open")
	if (act === "minimise") app_set("min")
	if (act === "signoff") { app_set("open"); run_signon() }
	if (act === "exit") app_close()
})
// With a menu already open, sliding across the bar switches to the next one — the way a
// real menu bar behaves once it has focus.
$("menubar").addEventListener("mouseover", function (event) {
	var name = event.target.dataset && event.target.dataset.menu
	if (name && open_menu && open_menu !== name) set_pop(name)
})
document.addEventListener("click", function () { set_pop(null) })

/* ---- Toolbar and action wiring ---- */
$("tabs").onclick = function (event) {
	if (!event.target.dataset || !event.target.dataset.tab) return
	tab = event.target.dataset.tab
	render_reader()
}
$("r-prev").onclick = function () {
	var i = messages.indexOf(current)
	if (i > 0) open_message(messages[i - 1])
}
$("r-next").onclick = function () {
	var i = messages.indexOf(current)
	if (i >= 0 && i < messages.length - 1) open_message(messages[i + 1])
}
$("t-read").onclick = function () { if (selected) open_message(selected) }
// Mail Center brings the mailbox back, which is what it is for.
$("t-refresh").onclick = function () { open_window("mailbox"); load() }
$("t-print").onclick = function () { window.print() }
$("a-read").onclick = function () { if (selected) open_message(selected) }
$("keepnew").onclick = function () {
	if (!selected) return
	delete read[selected.id]
	if (current && current.id === selected.id) current = null
	selected = null
	render_list()
	render_reader()
}
function wipe() {
	if (!confirm("Delete every message in the inbox?")) return
	fetch(api + "/messages", { method: "DELETE" }).then(function () {
		current = null
		seen = 0
		read = {}
		load()
	})
}
$("t-delete").onclick = wipe
$("a-delete").onclick = wipe


/* ---- Start menu, opened by the Windows key (Cmd on macOS — both report "Meta") ---- */
var menu = $("startmenu")
function set_menu(open) {
	menu.className = open ? "open" : ""
	$("start").className = open ? "on" : ""
}
$("start").onclick = function (event) {
	event.stopPropagation()
	set_menu(menu.className !== "open")
}
document.addEventListener("click", function () { set_menu(false) })
menu.addEventListener("click", function (event) { event.stopPropagation() })

/*
 * Only a *bare* Meta press counts. Holding it as a modifier is how you copy, reload and
 * switch tabs, so anything with another key in between is left well alone.
 */
var meta_alone = false
document.addEventListener("keydown", function (event) {
	if (event.key === "Meta") meta_alone = true
	else meta_alone = false
	if (event.key === "Escape") set_menu(false)
	restart()
})
document.addEventListener("keyup", function (event) {
	if (event.key === "Meta" && meta_alone) set_menu(menu.className !== "open")
	meta_alone = false
})

/*
 * Anything that needs the desktop signs you on first. The sign-on is a modal over an inbox
 * that is already live, so there is nothing to wait for — and a Start menu whose items are
 * clickable but do nothing is worse than not offering them.
 */
function ensure_signed_on() {
	if (!$("screen").classList.contains("signing")) return
	$("signon").className = ""
	end_intro()
}

function launch_app() {
	ensure_signed_on()
	app_set("open")
	open_window("mailbox")
	focus_app()
}
$("m-app").onclick = function () { launch_app(); set_menu(false) }
// The mailbox is its own window: bringing it back does not drag the app up with it.
$("m-mailbox").onclick = function () { ensure_signed_on(); open_window("mailbox"); set_menu(false) }
$("m-refresh").onclick = function () { ensure_signed_on(); open_window("mailbox"); load(); set_menu(false) }
/* noopener on every outward link: the opened tab has no business reaching back in here. */
function open_link(url) {
	window.open(url, "_blank", "noopener")
	set_menu(false)
}
$("m-docs").onclick = function () { open_link("https://docs.postboi.app") }
$("m-help").onclick = function () { open_link("https://docs.postboi.app/dev-inbox") }
$("m-dashboard").onclick = function () { open_link("https://postboi.app/dashboard") }
$("m-site").onclick = function () { open_link("https://postboi.app") }
$("m-wipe").onclick = function () { set_menu(false); wipe() }
$("m-sound").onclick = function () { $("t-sound").click(); set_menu(false) }
FOLDERS.forEach(function (name) {
	$("f-" + name).onclick = function () {
		folder = name
		render_list()
	}
})
$("m-signoff").onclick = function () { set_menu(false); app_set("open"); run_signon() }
// Turning the computer off is the only way to reach the stop error — closing the app just
// closes the app, the way closing an application does.
$("m-shutdown").onclick = function () {
	set_menu(false)
	play("shutdown")
	app_crash()
}

/*
 * The desktop's bitmaps. Wired here rather than in the stylesheet because only script knows
 * where the inbox is mounted — the wallpaper goes on once it has actually decoded, so a slow
 * load shows the drawn gradient instead of a blank screen.
 */
$("start").style.backgroundImage = "url(" + api + "/desktop/start)"
$("sc-app").querySelector("img").src = api + "/desktop/icon"
$("m-app").querySelector("img").src = api + "/desktop/icon"
$("m-face").src = api + "/desktop/avatar"
// The three moods of the status bar, loaded up front: a face that arrives from the network
// the first time something bites you is a face that arrives after the moment has passed.
var POOM_FACES = {
	ok: "face", hurt: "nervous", low: "crying",
	dead: "exhausted", won: "celebrating", god: "goat",
	wink: "wink", godwink: "goatwink",
}
Object.keys(POOM_FACES).forEach(function (mood) {
	$("poom-faces").querySelector(".f-" + mood).src = api + "/desktop/" + POOM_FACES[mood]
})
$("introwordmark").src = api + "/art/logo"
var paper = new Image()
paper.onload = function () {
	$("screen").style.backgroundImage = "url(" + api + "/desktop/wallpaper)"
	$("screen").classList.add("papered")
}
paper.src = api + "/desktop/wallpaper"

/*
 * The clip is fetched up front rather than at the moment it is wanted: it comes over the
 * network from Mux, and a minimise that sat waiting on a download would be worse than no clip
 * at all. By the time anyone minimises it is normally already buffered, so play() is instant.
 * Unreachable, it stays hidden and the wallpaper — its own opening frame — is what shows.
 */
var bliss_ready = false
$("bliss").addEventListener("canplaythrough", function () { bliss_ready = true })
$("bliss").addEventListener("error", function () { bliss_ready = false })
$("bliss").src = api + "/desktop/blissy"

/*
 * The desktop shortcuts. Double click to launch, the way a desktop icon works — and the drag
 * has to distinguish itself from a click, or picking an icon up would open it as well.
 */
var LAUNCH = { "sc-app": launch_app, "sc-poom": poom_open }
var icons = [].slice.call(document.querySelectorAll(".shortcut"))
icons.forEach(function (icon) {
	icon.ondblclick = LAUNCH[icon.id]
	icon.addEventListener("mousedown", function (event) {
		event.preventDefault()
		icons.forEach(function (other) { other.className = "shortcut" })
		icon.className = "shortcut on"
		var dx = event.clientX - icon.offsetLeft
		var dy = event.clientY - icon.offsetTop
		var box = ws_rect()
		track(function (e) {
			icon.style.left = Math.max(0, Math.min(box.w - icon.offsetWidth, e.clientX - dx)) + "px"
			icon.style.top = Math.max(0, Math.min(box.h - icon.offsetHeight, e.clientY - dy)) + "px"
		})
	})
})
// Clicking the desktop itself drops the selection, as it does on a real one.
$("icons").addEventListener("mousedown", function (event) {
	if (event.target === $("icons")) icons.forEach(function (icon) { icon.className = "shortcut" })
})

apply_mute(muted)
$("t-sound").onclick = function () {
	localStorage.setItem("postboi:sound", muted ? "on" : "off")
	apply_mute(!muted)
	if (!muted) play("welcome")
}

/*
 * The sign-on. Purely theatre over an inbox that's already live behind it — the fetch and
 * the event stream start immediately, so cancelling never costs you anything.
 */
var STEP_ART = ["locating", "connecting", "intercepting"]
var intro_timers = []
function end_intro() {
	intro_timers.forEach(clearTimeout)
	intro_timers = []
	// The handshake belongs to the dialog: it stops the moment the mailbox is up, and the
	// greeting lands on the main screen rather than over the top of it.
	stop_dialing()
	pending = null
	$("intro").className = ""
	document.body.classList.remove("connecting")
	// Revealed here rather than by wrapping this function: Cancel and the close box both
	// captured a reference to it before any wrapper could be installed.
	$("screen").classList.remove("signing")
	play("welcome")
}
function run_intro() {
	for (var i = 0; i < 3; i++) {
		$("s" + i).className = "step"
		$("s" + i).querySelector(".box").style.backgroundImage = ""
	}
	$("intro").className = "open"
	drag_dialog($("introwin"))
	dialing = play("dialup")
	var step = 300
	for (var i = 0; i < 3; i++) {
		;(function (n) {
			intro_timers.push(setTimeout(function () {
				if (n > 0) $("s" + (n - 1)).className = "step done"
				$("s" + n).className = "step on"
				// The panel arrives with the step, which is what makes the boxes fill in one
				// at a time rather than all being there from the start.
				$("s" + n).querySelector(".box").style.backgroundImage =
					"url(" + api + "/art/" + STEP_ART[n] + ")"
			}, step + n * 820))
		})(i)
	}
	intro_timers.push(setTimeout(function () {
		$("s2").className = "step done"
	}, step + 3 * 820))
	intro_timers.push(setTimeout(end_intro, step + 3 * 820 + 380))
}
$("intro-cancel").onclick = end_intro
$("introwin").querySelector('[data-act="close"]').onclick = end_intro

/*
 * Opening layout. The mailbox takes the top third and the reader the rest — mail is the
 * thing you came to read, so it gets the room by default, and both can be moved, resized
 * or maximised from there.
 */
var box = ws_rect()
/* Centred, the way the screenshots have it: the mailbox floating mid-desktop and mail
   opening in front of it, rather than the two tiled edge to edge. */
var mb = { w: Math.min(760, box.w - 40), h: Math.min(430, box.h - 40) }
register("mailbox", "Your Local Mailbox", {
	x: Math.round((box.w - mb.w) / 2),
	y: Math.round((box.h - mb.h) / 2),
	w: mb.w,
	h: mb.h,
})
/* Centred both ways, in front of the mailbox. */
var rd = { w: Math.min(700, box.w - 60), h: Math.min(430, box.h - 60) }
register("reader", "Message", {
	x: Math.round((box.w - rd.w) / 2),
	y: Math.max(0, Math.round((box.h - rd.h) / 2)),
	w: rd.w,
	h: rd.h,
})
/* Offset from the reader, so a mail and a conversation can be open side by side-ish. */
var mg = { w: Math.min(560, box.w - 80), h: Math.min(470, box.h - 50) }
register("messenger", "Conversation", {
	x: Math.min(box.w - mg.w, Math.round((box.w - mg.w) / 2) + 36),
	y: Math.max(0, Math.round((box.h - mg.h) / 2) - 10),
	w: mg.w,
	h: mg.h,
})
/* The channel apps, each offset its own way so opening several doesn't stack them. */
var wa = { w: Math.min(430, box.w - 60), h: Math.min(520, box.h - 30) }
register("wawin", "WhatsApp", {
	x: Math.max(0, Math.round((box.w - wa.w) / 2) - 60),
	y: Math.max(0, Math.round((box.h - wa.h) / 2) - 6),
	w: wa.w,
	h: wa.h,
})
var pl = { w: Math.min(560, box.w - 70), h: Math.min(460, box.h - 40) }
register("platwin", "Chat", {
	x: Math.min(box.w - pl.w, Math.round((box.w - pl.w) / 2) + 52),
	y: Math.max(0, Math.round((box.h - pl.h) / 2) + 8),
	w: pl.w,
	h: pl.h,
})
var pu = { w: Math.min(380, box.w - 80), h: Math.min(480, box.h - 40) }
register("pushwin", "Notifications", {
	// A shade hangs off the tray, so it opens against the right edge.
	x: Math.max(0, box.w - pu.w - 14),
	y: Math.max(0, Math.round((box.h - pu.h) / 2) - 12),
	w: pu.w,
	h: pu.h,
})
// A capture is a tall scrolling render, so the viewer is portrait and roomy.
var sh = { w: Math.min(520, box.w - 60), h: Math.min(620, box.h - 30) }
register("shotwin", "Preview", {
	x: Math.max(0, Math.round((box.w - sh.w) / 2) + 30),
	y: Math.max(0, Math.round((box.h - sh.h) / 2) - 10),
	w: sh.w,
	h: sh.h,
})
$("shot-prev").addEventListener("click", function () { step_shot(-1) })
$("shot-next").addEventListener("click", function () { step_shot(1) })

// A message box sits where XP put one: centred, above everything, not resizable.
var al = { w: Math.min(400, box.w - 40), h: 150 }
register("alertwin", "Postboi", {
	x: Math.max(0, Math.round((box.w - al.w) / 2)),
	y: Math.max(0, Math.round((box.h - al.h) / 2) - 40),
	w: al.w,
	h: al.h,
})
// A real tab, not a window on this desktop: the desktop is a joke, paying is not. The
// packs sit on the testing page beside the balance they refill; changing plan is a
// different decision and lives on its own page.
function open_out(which) {
	var url = alert_billing && alert_billing[which]
	if (url) window.open(url, "_blank", "noreferrer")
}
$("alert-upgrade").addEventListener("click", function () { open_out("plan") })
$("alert-topup").addEventListener("click", function () { open_out("packs") })
$("alert-ok").addEventListener("click", function () { close_window(find("alertwin")) })

/*
 * Coming back from the billing tab, ask again. A top-up lands on the account through a
 * Stripe webhook, so nothing here is told about it — but returning focus is the one
 * moment we know something might have changed, and it costs a single request.
 */
window.addEventListener("focus", function () {
	if (current && tab === "report") paint_shots(current.id)
})

var pm = { w: Math.min(660, box.w - 40), h: Math.min(444, box.h - 30) }
register("poom", "POOM.EXE", {
	x: Math.max(0, Math.round((box.w - pm.w) / 2) - 20),
	y: Math.max(0, Math.round((box.h - pm.h) / 2)),
	w: pm.w,
	h: pm.h,
})
/*
 * The handset leans against the right edge, fixed-size — relayout() re-centres windows
 * nobody has moved, and a phone snapping to the middle of the desk would break the
 * Winamp-ness of it, so it counts as placed from the start.
 */
register("pokia", "Pokia \\u00B7 Messages", {
	x: Math.max(6, box.w - 284),
	y: Math.max(4, box.h - 612),
	w: 254,
	h: 596,
})
find("pokia").placed = true
$("msn-them").src = api + "/desktop/avatar"
$("aol").classList.add("maxed")
focus_window("mailbox")
// They sit on the desktop, so it is the browser window changing size they have to survive.
window.addEventListener("resize", relayout)

clock()
setInterval(clock, 10000)

/*
 * Scheduled mail coming due. Nothing is actually queued — the inbox caught these instead of
 * sending them, and no timer is running anywhere but here — but while the page is open the
 * moment can still arrive, and a message quietly changing folders with no acknowledgement is
 * a worse lie than the sound is.
 */
var due = {}
messages.forEach(function (m) { due[m.id] = state_of(m) })
setInterval(function () {
	var arrived = false
	messages.forEach(function (m) {
		var state = state_of(m)
		if (due[m.id] === "scheduled" && state === "sent") arrived = true
		due[m.id] = state
	})
	if (!arrived) return
	play("sent")
	render_list()
	render_reader()
	render_messenger()
}, 1000)
new EventSource(api + "/events").onmessage = function () { load() }
load()
/*
 * Sign On first. It's the era-correct front door, and it doubles as the fix for a real
 * problem: browsers refuse audio until the page has been interacted with, so nothing was
 * ever going to be heard on a cold load. Pressing SIGN ON is that interaction, which is
 * why the handshake under the connecting dialog actually plays.
 */
function run_signon() {
	$("signon").className = "open"
	$("screen").classList.add("signing")
	drag_dialog($("signonwin"))
}
if (document.documentElement.dataset.intro === "on") run_signon()
else play("welcome")
$("so-go").onclick = function () {
	$("signon").className = ""
	run_intro()
}

$("so-help").onclick = function () {
	window.open("https://docs.postboi.app/dev-inbox", "_blank", "noopener")
}
`

/** How the page starts out. Both are still toggleable in the UI, and the choice sticks. */
export interface InboxUiOptions {
	/** Start with sounds on. Defaults to true. */
	sounds?: boolean
	/**
	 * Play the "Connecting To Postboi…" sign-on before showing the inbox. Defaults to true.
	 * Theatre only — the inbox loads behind it, so turning it off costs nothing but the joke.
	 */
	intro?: boolean
}

/** The inbox document. Built per request — it's a dev server, and a string is cheap. */
export function inbox_ui({ sounds = true, intro = true }: InboxUiOptions = {}): string {
	return `<!doctype html>
<html lang="en" data-sounds="${sounds ? "on" : "off"}" data-intro="${intro ? "on" : "off"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Postboi Local</title>
<!-- ${FREEDOOM_NOTICE} -->
<link rel="icon" href="${FAVICON}">
<style>${THEME_CSS}</style>
<style>${CSS}</style>
</head>
<body>
<div id="screen">

	<video id="bliss" muted playsinline preload="auto"></video>

	<div id="icons">
		<button class="shortcut" id="sc-app" style="left:22px;top:18px">
			<img src="" alt=""><span>Postboi</span>
		</button>
		<button class="shortcut" id="sc-poom" style="left:22px;top:112px">
			<img src="${POOM_ICON}" alt=""><span>POOM.EXE</span>
		</button>
	</div>

	<div id="aol" class="window">
		<div class="title-bar">
			<div class="title-bar-text"><img class="mark" src="${FAVICON}" alt=""> Postboi Local</div>
			<div class="title-bar-controls">
				<button aria-label="Minimize" data-app="min"></button>
				<button aria-label="Restore" data-app="max"></button>
				<button aria-label="Close" data-app="close"></button>
			</div>
		</div>
		<div id="menubar">
			<span data-menu="file"><u>F</u>ile</span>
			<span data-menu="window"><u>W</u>indow</span>
			<span data-menu="help"><u>H</u>elp</span>
			<div class="menu-pop" id="menu-file"><ul>
				<li data-do="mailbox">Open Mailbox</li>
				<li data-do="check">Check Mail Now</li>
				<li class="sep"></li>
				<li data-do="print">Print&#8230;</li>
				<li class="sep"></li>
				<li data-do="signoff">Sign Off</li>
				<li data-do="exit">Exit</li>
			</ul></div>
			<div class="menu-pop" id="menu-window"><ul>
				<li data-do="mailbox">Your Local Mailbox</li>
				<li data-do="restore">Restore Postboi Local</li>
				<li data-do="minimise">Minimise Postboi Local</li>
			</ul></div>
			<div class="menu-pop" id="menu-help"><ul>
				<li data-do="docs">Postboi Help&#8230;</li>
			</ul></div>
		</div>

		<div id="toolbar">
			<div class="band b1">
				<button class="tb" id="t-read"><span class="ico">&#128229;</span>Read</button>
				<button class="tb" id="t-refresh"><span class="ico">&#128260;</span>Mail Center</button>
				<button class="tb" id="t-print"><span class="ico">&#128424;</span>Print</button>
				<button class="tb" id="t-delete"><span class="ico">&#128465;</span>Delete All</button>
			</div>
			<div class="band b2">
				<button class="tb" id="t-sound"><span class="ico">&#128266;</span>Sound</button>
			</div>
			<div class="band b5"><span style="color:#fff;font:italic bold 15px Arial,sans-serif">postboi.</span></div>
		</div>


		<div id="workspace"></div>
		<span class="edge edge-r"></span><span class="edge edge-b"></span><span class="grip"></span>
	</div>

	<div id="mailbox" class="child window">
		<div class="title-bar">
			<div class="title-bar-text"><img class="mark" src="${FAVICON}" alt=""> Your Local Mailbox</div>
			<div class="title-bar-controls">
				<button aria-label="Minimize" data-act="min"></button>
				<button aria-label="Maximize" data-act="max"></button>
				<button aria-label="Close" data-act="close"></button>
			</div>
		</div>

		<div id="mbhead">
			<div class="mark">
				<svg width="42" height="34" viewBox="0 0 46 34" aria-hidden="true">
					<g class="flag">
						<path d="M27 30V4h3v26z" fill="#3a3a3a"/>
						<path d="M30 4h14l-4 4.5 4 4.5H30z" fill="#fdc005" stroke="#000" stroke-width="2" stroke-linejoin="round"/>
					</g>
					<path d="M3 16a11 11 0 0 1 22 0v13H3z" fill="#e8e8e8" stroke="#000" stroke-width="2" stroke-linejoin="round"/>
					<path d="M14 5v24" stroke="#000" stroke-width="2"/>
					<path d="M14 16a5.5 5.5 0 0 1 11 0v13H14z" fill="#fff" stroke="#000" stroke-width="2" stroke-linejoin="round"/>
				</svg>
				<span>Mailbox</span>
			</div>
		</div>

		<div id="folders">
			<button id="f-outbox" class="on">Outbox</button>
			<button id="f-sent">Sent</button>
			<button id="f-scheduled">Scheduled</button>
			<button id="f-deleted">Deleted</button>
		</div>
		<div id="listwrap">
			<div id="list" class="thin-sunken">
				<table><tbody id="rows"></tbody></table>
				<div id="empty"></div>
			</div>
		</div>

		<div id="actions">
			<button class="aolbtn" id="a-read">Read</button>
			<button class="aolbtn" id="keepnew" disabled>Keep As New</button>
			<span class="spacer"></span>
			<button class="aolbtn" id="a-delete">Delete All</button>
		</div>
		<span class="edge edge-r"></span><span class="edge edge-b"></span><span class="grip"></span>
	</div>


	<div id="signon">
		<div id="signonwin" class="child window">
			<div class="title-bar">
				<div class="title-bar-text"><img class="mark" src="${FAVICON}" alt=""> Sign On</div>
			</div>
			<div id="signonbody">
				<div class="side">
					<img src="${FAVICON}" alt="">
					<div class="name">postboi</div>
					<div class="ver">local edition</div>
				</div>
				<div class="fields">
					<label for="so-name">Select Screen Name:</label>
					<select id="so-name" disabled><option>Postboi</option></select>
					<label for="so-pass">Enter Password:</label>
					<input id="so-pass" type="password" value="secret" disabled>
					<label for="so-loc">Select Location:</label>
					<select id="so-loc" disabled><option>Local 33.6k Modem</option></select>
					<div class="row">
						<button id="so-help">HELP</button>
						<button id="so-go">SIGN ON</button>
					</div>
				</div>
			</div>
		</div>
	</div>

	<div id="intro">
		<div id="introwin" class="child window">
			<div class="title-bar">
				<div class="title-bar-text"><img class="mark" src="${FAVICON}" alt=""> Connecting To Postboi&#8230;</div>
				<div class="title-bar-controls"><button aria-label="Close" data-act="close"></button></div>
			</div>
			<div id="introbody">
				<div id="intrologo"><img id="introwordmark" src="" alt="postboi"></div>
				<div id="steps">
					<div class="step" id="s0"><div class="box"></div><span class="cap">1. Locating mailroom&#8230;</span></div>
					<div class="step" id="s1"><div class="box"></div><span class="cap">2. Connecting to localhost&#8230;</span></div>
					<div class="step" id="s2"><div class="box"></div><span class="cap">3. Intercepting outgoing mail&#8230;</span></div>
				</div>
				<div id="introfoot"><button class="aolbtn" id="intro-cancel">Cancel</button></div>
			</div>
		</div>
	</div>
	<div id="reader" class="child window">
		<div class="title-bar">
			<div class="title-bar-text"><svg class="mailico" viewBox="0 0 16 13" aria-hidden="true"><rect x=".5" y="1.5" width="15" height="10" fill="#fdfbf2" stroke="#3f3f3f"/><path d="M.5 1.5 8 7.6l7.5-6.1" fill="none" stroke="#3f3f3f"/></svg> <span id="reader-title"></span></div>
			<div class="title-bar-controls">
				<button aria-label="Minimize" data-act="min"></button>
				<button aria-label="Maximize" data-act="max"></button>
				<button aria-label="Close" data-act="close" id="reader-close"></button>
			</div>
		</div>
		<div id="head"></div>
		<div id="tabs">
			<button data-tab="html" class="on">Message</button>
			<button data-tab="text">Plain Text</button>
			<button data-tab="source">Source</button>
			<button data-tab="report">Report</button>
			<button data-tab="files">Attachments</button>
		</div>
		<div id="pane" class="thin-sunken"></div>
		<div id="readerfoot">
			<button class="aolbtn" id="r-prev">&#9664; Prev</button>
			<span id="r-count"></span>
			<button class="aolbtn" id="r-next">Next &#9654;</button>
		</div>
		<span class="edge edge-r"></span><span class="edge edge-b"></span><span class="grip"></span>
	</div>

	<div id="messenger" class="child window">
		<div class="title-bar">
			<div class="title-bar-text">&#128172; <span id="msn-title">Conversation</span></div>
			<div class="title-bar-controls">
				<button aria-label="Minimize" data-act="min"></button>
				<button aria-label="Maximize" data-act="max"></button>
				<button aria-label="Close" data-act="close"></button>
			</div>
		</div>
		<div id="msnbar">
			<button data-say="No one else is coming. It's a dev inbox."><span class="ico">&#128101;</span>Invite</button>
			<button data-say="Attachments ride the email channel."><span class="ico">&#128190;</span>Send Files</button>
			<button data-say="The webcam is a drawing of a webcam."><span class="ico">&#128249;</span>Webcam</button>
			<button data-say="Voice clip failed: the modem is using the line."><span class="ico">&#127908;</span>Voice</button>
			<button data-say="Minesweeper is on the other machine."><span class="ico">&#127918;</span>Games</button>
		</div>
		<div id="msnto">To: <b id="msn-to"></b> <span id="msn-chan" class="chan"></span></div>
		<div id="msnmain">
			<div id="msncol">
				<div id="msnhistory" class="selectable"></div>
				<div id="msnentry">
					<textarea id="msn-text" class="selectable" rows="2"></textarea>
					<div class="row">
						<span class="hint">Messenger Plus! not detected</span>
						<span class="btns">
							<button class="aolbtn" id="msn-nudge">Nudge</button>
							<button class="aolbtn" id="msn-send">Send</button>
						</span>
					</div>
				</div>
			</div>
			<div id="msnpics">
				<div class="pic"><img id="msn-them" src="" alt=""></div>
				<div class="pic"><img src="${FAVICON}" alt="The Postboi mascot"></div>
			</div>
		</div>
		<span class="edge edge-r"></span><span class="edge edge-b"></span><span class="grip"></span>
	</div>

	<div id="wawin" class="child window conv">
		<div class="title-bar">
			<div class="title-bar-text">&#128994; <span id="wa-title">WhatsApp</span></div>
			<div class="title-bar-controls">
				<button aria-label="Minimize" data-act="min"></button>
				<button aria-label="Maximize" data-act="max"></button>
				<button aria-label="Close" data-act="close"></button>
			</div>
		</div>
		<div id="wahead">
			<span class="face">&#128100;</span>
			<span class="who"><b id="wa-to"></b><small>last seen just now &#183; captured, never delivered</small></span>
		</div>
		<div id="wachat" class="selectable"></div>
		<div id="wafoot">
			<span class="wain">
				<button class="icobtn" data-wa="The stickers never left 2003.">&#9786;</button>
				<input id="wa-text" placeholder="Type a message" class="selectable">
			</span>
			<button class="icobtn" id="wa-mic" data-wa="Voice notes need a voice. Your app only types.">&#127908;</button>
		</div>
		<span class="edge edge-r"></span><span class="edge edge-b"></span><span class="grip"></span>
	</div>

	<div id="platwin" class="child window conv">
		<div class="title-bar">
			<div class="title-bar-text">&#128172; <span id="plat-title">Chat</span></div>
			<div class="title-bar-controls">
				<button aria-label="Minimize" data-act="min"></button>
				<button aria-label="Maximize" data-act="max"></button>
				<button aria-label="Close" data-act="close"></button>
			</div>
		</div>
		<div id="platbody">
			<div class="plathead"><span class="dot" id="plat-glyph">#</span><span id="plat-name"></span><small id="plat-sub"></small></div>
			<div id="plathist" class="selectable"></div>
			<div id="platentry">
				<input id="plat-input" placeholder="" class="selectable">
			</div>
		</div>
		<span class="edge edge-r"></span><span class="edge edge-b"></span><span class="grip"></span>
	</div>

	<div id="pushwin" class="child window conv">
		<div class="title-bar">
			<div class="title-bar-text">&#128276; <span>Notifications</span></div>
			<div class="title-bar-controls">
				<button aria-label="Minimize" data-act="min"></button>
				<button aria-label="Maximize" data-act="max"></button>
				<button aria-label="Close" data-act="close"></button>
			</div>
		</div>
		<div id="pushbody" class="selectable"></div>
		<span class="edge edge-r"></span><span class="edge edge-b"></span><span class="grip"></span>
	</div>

	<!-- The system message box. XP threw one of these whenever something needed a
	     decision, and an exhausted render allowance is exactly that: the reason is
	     the vendor's, and the way out is a page on the account it was ordered from. -->
	<div id="alertwin" class="child window closed dlg">
		<div class="title-bar">
			<div class="title-bar-text"><span id="alert-title">Postboi</span></div>
			<div class="title-bar-controls">
				<button aria-label="Close" data-act="close"></button>
			</div>
		</div>
		<div class="dlgbody">
			<div class="dlgrow"><div class="dlgicon">!</div><div id="alert-text"></div></div>
			<div class="dlgbtns">
				<button id="alert-upgrade">Upgrade Plan</button>
				<button id="alert-topup">Buy More Renders</button>
				<button id="alert-ok">OK</button>
			</div>
		</div>
	</div>

	<!-- A capture off the rendering farm opens as its own window, the way every other
	     thing on this desktop does. Starts closed: a screenshot opens it. -->
	<div id="shotwin" class="child window closed">
		<div class="title-bar">
			<div class="title-bar-text">&#128247; <span id="shot-title">Preview</span></div>
			<div class="title-bar-controls">
				<button aria-label="Minimize" data-act="min"></button>
				<button aria-label="Maximize" data-act="max"></button>
				<button aria-label="Close" data-act="close"></button>
			</div>
		</div>
		<div id="shotbody" class="shotbody">
			<div class="shot-stage"><img id="shot-img" alt=""></div>
			<div class="shot-foot">
				<button id="shot-prev" class="shot-nav">&#9664; Prev</button>
				<span id="shot-count"></span>
				<button id="shot-next" class="shot-nav">Next &#9654;</button>
			</div>
		</div>
		<span class="edge edge-r"></span><span class="edge edge-b"></span><span class="grip"></span>
	</div>

	<!-- Starts closed: it is an icon on the desktop, not something the inbox opens for you. -->
	<div id="poom" class="child window closed">
		<div class="title-bar">
			<div class="title-bar-text">&#128163; <span>POOM.EXE</span></div>
			<div class="title-bar-controls">
				<button aria-label="Minimize" data-act="min"></button>
				<button aria-label="Maximize" data-act="max"></button>
				<button aria-label="Close" data-act="close"></button>
			</div>
		</div>
		<div id="poomstage"><canvas id="poom-view" width="320" height="176"></canvas></div>
		<div id="poomhud">
			<!-- Six faces, one showing. The status bar is the health bar you actually read. -->
			<span id="poom-faces" class="face-ok">
				<img class="f-ok" src="" alt="">
				<img class="f-hurt" src="" alt="">
				<img class="f-low" src="" alt="">
				<img class="f-dead" src="" alt="">
				<img class="f-won" src="" alt="">
				<img class="f-god" src="" alt="">
				<img class="f-wink" src="" alt="">
				<img class="f-godwink" src="" alt="">
			</span>
			<span class="stat">AMMO<b id="poom-ammo">40</b></span>
			<span class="stat">HEALTH<b id="poom-health">100%</b></span>
			<span class="stat">SPAM<b id="poom-spam">20</b></span>
			<span class="spacer"></span>
			<span class="keys">Arrows / WASD move &#183; drag to look<br>Space shoots. Clear the inbox.</span>
		</div>
		<span class="edge edge-r"></span><span class="edge edge-b"></span><span class="grip"></span>
	</div>

	<!-- The handset. Not a .window on purpose: no XP frame, no title bar — the shell is
	     the chrome, the way a Winamp skin was. Dragged by its body, powered off from the
	     button on its crown, and still a citizen of the taskbar like everything else. -->
	<div id="pokia" class="child conv">
		<div class="nk-shell">
			<button class="nk-power" aria-label="Power off"></button>
			<div class="nk-ear"><i></i><i></i><i></i><i></i><i></i></div>
			<div class="nk-brand">POKIA</div>
			<!-- The text layer and the game layer are siblings: the firmware redraws its screen
			     by replacing the one, and Snake would be wiped out with it if it lived inside. -->
			<div class="nk-bezel">
				<div class="nk-lcd" id="nk-lcd">
					<div id="nk-screen"></div>
					<canvas id="nk-game" width="186" height="214"></canvas>
				</div>
			</div>
			<div class="nk-navi">
				<button class="nk-key nk-side up" id="nk-up" aria-label="Scroll up">&#9650;</button>
				<button class="nk-key nk-mid" id="nk-mid" aria-label="Select"></button>
				<button class="nk-key nk-side dn" id="nk-dn" aria-label="Scroll down">&#9660;</button>
			</div>
			<!-- The keypad types. Nothing here dials, but the letters printed on the keys are
			     the same ones the 3310 had, and something on this phone still answers to them. -->
			<div class="nk-pad">
				<button class="nk-key" data-nk="1">1</button>
				<button class="nk-key" data-nk="2">2<small>abc</small></button>
				<button class="nk-key" data-nk="3">3<small>def</small></button>
				<button class="nk-key" data-nk="4">4<small>ghi</small></button>
				<button class="nk-key" data-nk="5">5<small>jkl</small></button>
				<button class="nk-key" data-nk="6">6<small>mno</small></button>
				<button class="nk-key" data-nk="7">7<small>pqrs</small></button>
				<button class="nk-key" data-nk="8">8<small>tuv</small></button>
				<button class="nk-key" data-nk="9">9<small>wxyz</small></button>
				<button class="nk-key" data-nk="*">*</button>
				<button class="nk-key" data-nk="0">0</button>
				<button class="nk-key" data-nk="#">#</button>
			</div>
		</div>
	</div>

	<div id="taskbar">
		<button id="start"><span>start</span></button>
		<button class="task on" id="app-task"><img class="mark" src="${FAVICON}" alt="">Postboi Local</button>
		<span id="tasks" style="display:flex;gap:4px"></span>
		<span class="spacer"></span>
		<!-- The count lives out here rather than in the mailbox header, which is the first
		     thing hidden when a message is open. -->
		<span id="tray">
			<span id="count"></span>
			<span id="stat">Waiting for mail&#8230;</span>
			<span id="clock"></span>
		</span>
	</div>

	<div id="startmenu">
		<div class="head"><img id="m-face" src="" alt=""> Postboi</div>
		<div class="cols">
			<ul class="left">
				<li id="m-app"><img class="ico-app" src="" alt=""><span><b>Postboi Local</b><small>Your mail, going nowhere</small></span></li>
				<li id="m-mailbox"><span class="ico">&#128236;</span>Your Local Mailbox</li>
				<li class="sep"></li>
				<li id="m-refresh"><span class="ico">&#128260;</span>Check Mail Now</li>
				<li id="m-wipe"><span class="ico">&#128465;</span>Delete All Mail&#8230;</li>
			</ul>
			<ul class="right">
				<li id="m-dashboard"><span class="ico">&#128202;</span>Postboi Dashboard</li>
				<li id="m-site"><span class="ico">&#127760;</span>postboi.app</li>
				<li class="sep"></li>
				<li id="m-docs"><span class="ico">&#128218;</span>Documentation</li>
				<li id="m-help"><span class="ico">&#10067;</span>Help and Support</li>
				<li class="sep"></li>
				<li id="m-sound"><span class="ico">&#128266;</span>Sounds and Audio</li>
			</ul>
		</div>
		<div class="foot">
			<button id="m-signoff"><span class="badge logoff">&#8617;</span>Log Off</button>
			<button id="m-shutdown"><span class="badge off">&#9211;</span>Turn Off Computer</button>
		</div>
	</div>




	<div id="bsod">
		<div class="face">:(</div>
		<p class="lead">Your PC ran into a problem that it couldn&#8217;t handle, and now it needs to restart.</p>
		<p class="code">You can search for the error online: MAIL_DELIVERY_SUBSYSTEM_FAILED</p>
		<p class="code hint">Press any key to restart.</p>
	</div>

</div>
<script>${SCRIPT}</script>
</body>
</html>`
}
