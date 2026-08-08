/**
 * The dev inbox's UI: one self-contained document, no build step, no dependencies. It's
 * dressed as AOL 4.0 on Windows 98 because a local mail client that looks nothing like
 * production mail is a feature — you can never mistake a screenshot of this for the real
 * thing.
 *
 * Window chrome comes from XP.css (vendored in inbox_theme.ts); the AOL furniture on top of
 * it — the coloured toolbar bands, the mailbox header, the folder tabs — is ours, because no
 * OS framework ships those.
 */

import { THEME_CSS } from "./inbox_theme.js"
import type { Channel } from "./errors.js"

/**
 * Channel chip labels, typed here (and inlined into the client script below) so adding a
 * channel without a label is a compile error rather than a blank chip.
 */
const CHANNEL_LABELS = {
	sms: "SMS",
	whatsapp: "WhatsApp",
	chat: "Chat",
	push: "Push",
} satisfies Record<Exclude<Channel, "email">, string>

/**
 * The Postboi mark, inlined as a data URI — the tab icon, and the badge in every title
 * bar and on the sign-on. Copied from static/favicon.svg; the published package has no
 * static directory to serve it from.
 */
const FAVICON =
	"data:image/svg+xml,%3Csvg%20width%3D%22664%22%20height%3D%22664%22%20viewBox%3D%22-76%20-76%20664%20664%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%20%3Cpath%20d%3D%22M68.3939%20168.189L68.3751%20168.72C56.7497%20176.365%2028.1454%20195.529%2025.0885%20209.716C21.192%20227.793%2049.1638%20244.048%2064.0193%20248.609C63.4697%20259.384%2063.0556%20277.148%2064.968%20287.805C51.0574%20290.624%2039.5035%20295.187%2031.4207%20307.82C14.5473%20334.193%2022.5963%20369.062%2049.2014%20385.517C56.7911%20390.265%2061.3426%20391.191%2069.768%20393.42C69.768%20444.235%20139.294%20508.235%20239.059%20510.118C338.824%20512%20421.921%20443.237%20431.059%20393.412C502.84%20388.804%20506.628%20299.158%20448.185%20287.251C451.509%20272.03%20452.36%20256.371%20450.696%20240.88C450.018%20234.704%20445.41%20227.947%20447.27%20223.786C455.074%20206.312%20451.95%20180.459%20447.338%20163.343C434.677%20116.336%20406.532%2090.6687%20371.302%2059.6648C356.703%2046.8178%20347.121%2034.0163%20328.976%2024.1441C289.145%202.47405%20245.056%20-1.48981%20201.947%2010.2346C154.414%2023.4762%20114.045%2054.9714%2089.6344%2097.8536C77.3953%20119.356%2069.3652%20143.371%2068.3939%20168.189Z%22%20fill%3D%22%230F1C41%22%2F%3E%20%3Cpath%20d%3D%22M259.765%20350.118C257.882%20363.294%20223.153%20378.787%20212.002%20360.205C209.292%20355.728%20208.558%20350.33%20209.981%20345.293C213.806%20331.236%20228.578%20323.482%20242.677%20325.848C253.933%20327.737%20261.647%20336.941%20259.765%20350.118Z%22%20fill%3D%22%23F88428%22%2F%3E%20%3Cpath%20d%3D%22M382.931%20206.464C384.968%20210.523%20381.768%20230.997%20384.102%20236.757C396.808%20268.104%20407.744%20293.006%20405.467%20328.039C405.29%20330.786%20407.202%20334.861%20409.943%20336.37C427.283%20345.914%20423.692%20308.011%20439.861%20306.756C465.269%20304.06%20475.641%20336.713%20461.681%20354.527C452.695%20366.002%20445.772%20368.185%20432.102%20370.493C429.757%20367.38%20425.228%20359.685%20421.324%20360.34C412.955%20369.443%20408.418%20411.819%20391.096%20429.908C367.996%20454.032%20347.117%20468.88%20315.445%20480.234C268.04%20497.225%20218.327%20500.756%20171.867%20479.057C148.334%20468.854%20124.842%20454.887%20107.713%20435.363C83.8557%20408.536%2086.991%20374.047%2085.9783%20341.249C85.0635%20311.741%2090.2667%20287.11%2092.3787%20258.482C114.026%20255.485%20119.346%20254.017%20139.765%20246.468C138.764%20248.746%20137.8%20251.039%20136.866%20253.346C135.545%20256.685%20135.285%20257.723%20136.588%20260.751L138.308%20261.038C146.124%20257.575%20175.838%20247.787%20178.428%20245.364L178.493%20243.202C177.1%20239.807%20173.666%20237.171%20170.873%20234.618C178.805%20234.647%20184.983%20234.719%20192.862%20233.878L192.592%20247.311C219.935%20247.071%20255.921%20232.44%20278.171%20217.064L271.684%20236.376C295.413%20231.261%20319.691%20227.567%20342.942%20221.005C355.833%20217.366%20369.021%20211.486%20381.403%20206.187L382.931%20206.464ZM301.832%20376.713C278.547%20394.038%20260.413%20404.775%20229.655%20400.242C217.559%20398.45%20206.039%20393.884%20195.995%20386.9C191.884%20384.005%20186.899%20378.215%20182.043%20378.475C175.609%20387.615%20190.642%20423.64%20195.562%20433.259C204.925%20447.941%20217.872%20460.85%20235.494%20464.675C277.218%20473.729%20299.226%20429.799%20305.254%20395.759C306.413%20389.201%20309.237%20379.804%20301.832%20376.713ZM271.609%20339.789C255.786%20289.622%20182.792%20315.676%20194.737%20361.579C202.557%20391.614%20282.353%20384%20271.609%20339.789ZM323.471%20280.553C315.983%20284.478%20311.809%20289.404%20309.663%20297.735C305.522%20313.818%20312.155%20350.775%20325.489%20350.446C338.823%20350.117%20346.372%20284.804%20323.471%20280.553ZM158.178%20280.733C132.861%20291.75%20139.11%20347.683%20158.893%20349.246C166.103%20346.02%20170.896%20341.404%20173.196%20333.701C178.361%20316.409%20180.074%20286.409%20158.178%20280.733ZM343.688%20262.393C352.9%20256.917%20336.038%20232.49%20314.049%20233.772C306.278%20238.797%20306.041%20242.327%20303.594%20251.289C321.728%20251.403%20325.162%20250.91%20340.149%20261.352L343.688%20262.393Z%22%20fill%3D%22%23FCC58F%22%2F%3E%20%3Cpath%20d%3D%22M232.975%20437.332C246.822%20435.984%20255.835%20437.479%20269.026%20441.236C264.588%20446.375%20263.473%20447.708%20258.026%20451.841C251.005%20453.999%20223.436%20453.942%20226.199%20442.17C228.364%20439.211%20229.73%20438.827%20232.975%20437.332Z%22%20fill%3D%22%23E04A6E%22%2F%3E%20%3Cpath%20d%3D%22M119.36%20355.277C126.82%20353.057%20133.485%20354.181%20140.405%20357.536C152.798%20363.54%20146.245%20376.615%20137.412%20378.353C129.95%20379.821%20122.561%20380.55%20116.706%20376.471C109.993%20371.793%20106.075%20359.23%20119.36%20355.277Z%22%20fill%3D%22%23F88428%22%2F%3E%20%3Cpath%20d%3D%22M355.765%20353.882C370.824%20353.882%20383.075%20379.154%20360.949%20378.753C338.824%20378.353%20332.853%20368.342%20334.897%20362.994C336.941%20357.647%20340.706%20353.882%20355.765%20353.882Z%22%20fill%3D%22%23F88428%22%2F%3E%20%3Cpath%20d%3D%22M89.0997%20152.275C98.6357%20121.566%20105.695%20102.135%20127.311%2077.2893C154.094%2046.5083%20197.561%2025.1854%20238.246%2022.7786C264.294%2021.2377%20299.118%2029.1564%20321.777%2042.6563C329.051%2046.9891%20338.056%2055.2078%20344.584%2060.9855C344.426%2062.0784%20344.223%2063.4853%20343.978%2065.2057C348.029%2076.4035%20353.657%2086.7079%20356.778%2098.2858C360.057%20110.451%20360.328%20123.204%20358.961%20135.672C358.517%20139.733%20357.113%20146.317%20353.578%20148.8C331.931%20137.956%20297.043%20123.309%20272.93%20123.096C281.529%20114.918%20288.166%20107.384%20289.22%2095.0328C290.459%2081.9801%20286.348%2068.984%20277.828%2059.0173C257.781%2035.2842%20227.957%2036.8142%20205.753%2055.4115C186.858%2071.2406%20187.2%20102.518%20203.453%20120.116C178.741%20121.775%20151.752%20127.447%20128.742%20136.741C117.644%20141.225%2099.9346%20149.561%2089.0997%20152.275Z%22%20fill%3D%22%238DB7D5%22%2F%3E%20%3Cpath%20d%3D%22M215.963%20135.277C268.149%20129.918%20349.802%20155.829%20387.686%20191.482C373.324%20188.181%20357.237%20186.536%20342.382%20183.3C310.442%20176.343%20274.124%20167.503%20241.713%20164.129C233.435%20162.617%20219.087%20162.461%20210.549%20162.202C158.645%20160.621%20113.905%20173.945%2065.7472%20191.06C113.811%20154.615%20155.219%20139.779%20215.963%20135.277Z%22%20fill%3D%22%23346696%22%2F%3E%20%3Cpath%20d%3D%22M344.584%2060.9855C382.532%2093.6552%20427.272%20132.896%20431.5%20186.19C431.921%20191.535%20433.284%20205.359%20430.295%20209.175C418.843%20203.351%20401.047%20176.297%20385.525%20168.839C384.825%20168.504%20352.592%20147.761%20353.578%20148.8C357.113%20146.317%20358.517%20139.733%20358.961%20135.672C360.328%20123.204%20360.057%20110.451%20356.778%2098.2858C353.657%2086.7078%20338.824%2065.8823%20344.584%2060.9855Z%22%20fill%3D%22%23588CB5%22%2F%3E%20%3Cpath%20d%3D%22M67.7048%20306.415C70.2159%20309.199%2069.7152%20364.109%2069.8093%20370.599C62.6451%20368.363%2059.2794%20366.251%2053.2258%20362.095C36.4653%20347.559%2037.5006%20322.281%2056.5726%20310.116C59.5768%20308.201%2064.2338%20307.25%2067.7048%20306.415Z%22%20fill%3D%22%23FCC58F%22%2F%3E%20%3Cpath%20d%3D%22M218.353%2065.8824C218.353%2065.8824%20244.706%2037.6471%20272.746%2067.4902L242.824%2080.9412L218.353%2065.8824Z%22%20fill%3D%22%23FEFDFD%22%2F%3E%20%3Cpath%20d%3D%22M242.824%2094.1176L264.607%20111.245C242.824%20128%20214.588%20111.245%20214.588%20111.245L242.824%2094.1176Z%22%20fill%3D%22%23FDC005%22%2F%3E%20%3Cpath%20d%3D%22M252.235%2088.4706L276.706%2077.1765C276.706%2077.1765%20286.118%2092.2353%20272.941%20103.529L252.235%2088.4706Z%22%20fill%3D%22%23FEFDFD%22%2F%3E%20%3Cpath%20d%3D%22M208.941%20101.647C208.941%20101.647%20201.412%2086.5882%20211.283%2074.8412L233.412%2088.4706L208.941%20101.647Z%22%20fill%3D%22%23FEFDFD%22%2F%3E%20%3C%2Fsvg%3E"

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
td.who { width: 34% }
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
#blank { display: flex; height: 100%; align-items: center; justify-content: center; color: #808080; text-align: center; line-height: 1.7 }
#readerfoot { display: flex; align-items: center; gap: 10px; padding: 0 10px 10px; background: #c0c0c0 }
#readerfoot #r-count { flex: 1; text-align: center; font-weight: bold; color: #17265c }

/* ---- Channel chips in the mailbox list ---- */
.chan {
	font: bold 9px Tahoma, Arial, sans-serif; letter-spacing: .02em; color: #0b5394;
	background: #dceafa; border: 1px solid #9db9d9; border-radius: 3px;
	padding: 0 4px; margin-left: 5px; vertical-align: 1px; text-transform: uppercase;
}
tr.on .chan { background: #2f5db3; color: #fff; border-color: #7aa0dc }

/*
 * ---- The Messenger window ----
 *
 * Texts, WhatsApp messages, chat posts and pushes open here instead of the mail reader,
 * because they are conversations, not letters. It is dressed as MSN Messenger with the
 * same shamelessness the rest of this wears AOL: the To: banner, the display-picture
 * boxes down the right, the toolbar of things that never worked, and the nudge.
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
`

const SCRIPT = `
var base = location.pathname.replace(/\\/+$/, "")
var FAVICON_URL = document.querySelector("link[rel=icon]").href
var api = base + "/api"
var messages = []
var current = null
var selected = null
var tab = "html"
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
function clock() {
	var d = new Date()
	var h = d.getHours()
	var m = d.getMinutes()
	var ampm = h >= 12 ? "PM" : "AM"
	h = h % 12
	if (!h) h = 12
	$("clock").textContent = h + ":" + (m < 10 ? "0" : "") + m + " " + ampm
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
		"Your outbox is empty.<br>Send anything from your app \\u2014 mail, texts, chats, pushes \\u2014 and it lands here.",
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
			"<td>" +
			esc(snip(m.subject || (chan === "email" ? "(no subject)" : m.text || "(no message)"), 90)) +
			(chan === "email" ? "" : ' <span class="chan">' + CHANNELS[chan] + "</span>") +
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

function open_message(m) {
	selected = m
	read[m.id] = true
	// Letters open in the mail reader; everything else is a conversation, and opens in one.
	if (channel_of(m) === "email") {
		current = m
		render_list()
		render_reader()
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

function load() {
	return fetch(api + "/messages").then(function (r) { return r.json() }).then(function (data) {
		messages = data.messages || []
		if (current) current = messages.filter(function (m) { return m.id === current.id })[0] || null
		if (convo) convo = messages.filter(function (m) { return m.id === convo.id })[0] || null
		// Gated on having loaded once rather than on having seen a message: an inbox that starts
		// empty has seen zero, which is exactly when the next arrival is the first one to chime.
		if (loaded && messages.length > seen) play("mail")
		seen = messages.length
		loaded = true
		render_list()
		render_reader()
		render_messenger()
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
function stamp(ms) {
	var d = new Date(ms)
	var h = d.getHours()
	var min = d.getMinutes()
	var ampm = h >= 12 ? "PM" : "AM"
	h = h % 12
	if (!h) h = 12
	return h + ":" + (min < 10 ? "0" : "") + min + " " + ampm
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
			" joins the conversation. Captured by the dev inbox \\u2014 nothing was actually sent.</div>",
	]
	thread.forEach(function (m) {
		parts.push(
			'<div class="says"><b>Your app</b> says: <span class="stamp">(' +
				stamp(m.received_at) + ")</span></div>"
		)
		var tpl = (m.meta || []).filter(function (pair) { return pair[0] === "Template" })[0]
		if (m.subject && !tpl) parts.push('<div class="line"><b>' + esc(m.subject) + "</b></div>")
		if (m.text) parts.push('<div class="line">' + esc(m.text) + "</div>")
		if (tpl) parts.push('<div class="tpl">\\u{1F4CB} ' + esc(tpl[1]) + "</div>")
		;(m.meta || []).forEach(function (pair) {
			if (pair[0] === "Template") return
			parts.push('<div class="sysline">\\u2736 ' + esc(pair[0]) + ": " + esc(pair[1]) + "</div>")
		})
		if (m.cancelled_at) {
			parts.push('<div class="sysline">This send was cancelled. It was never going out.</div>')
		} else if (state_of(m) === "scheduled") {
			parts.push('<div class="sysline">Scheduled \\u2014 sends ' + esc(when_full(m.scheduled_at)) + "</div>")
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
	msn_sys("This glass is one-way \\u2014 your app does the talking. Nothing was sent.")
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
	var bar = el.querySelector(".title-bar")
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
	el.querySelector(".grip").addEventListener("mousedown", function (e) { resize(win, e, true, true) })
	el.querySelector(".edge-r").addEventListener("mousedown", function (e) { resize(win, e, true, false) })
	el.querySelector(".edge-b").addEventListener("mousedown", function (e) { resize(win, e, false, true) })
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
	// Same deal for the messenger: closing the conversation is leaving it.
	if (win.id === "messenger") {
		convo = null
		render_list()
		render_messenger()
		return
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
		win.el.querySelector(".title-bar").className =
			"title-bar" + (focused === win.id && !win.min ? "" : " dim")
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
		if (state === "min") run_bliss()
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
 * The wallpaper's postman, once. He starts on the frame already showing — the wallpaper is
 * that frame — so there is no cut when he sets off, and he holds wherever he finishes. A
 * second minimise gets the wallpaper rather than the same gag twice.
 */
var bliss_played = false
function run_bliss() {
	if (bliss_played || !bliss_ready) return
	bliss_played = true
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
	if (act === "docs") window.open("https://docs.postboi.email/dev-inbox", "_blank", "noopener")
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
$("m-docs").onclick = function () { open_link("https://docs.postboi.email") }
$("m-help").onclick = function () { open_link("https://docs.postboi.email/dev-inbox") }
$("m-dashboard").onclick = function () { open_link("https://postboi.email/dashboard") }
$("m-site").onclick = function () { open_link("https://postboi.email") }
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
 * The desktop shortcut. Double click to launch, the way a desktop icon works — and the drag
 * has to distinguish itself from a click, or picking the icon up would open the app as well.
 */
var shortcut = $("sc-app")
shortcut.ondblclick = function () { launch_app() }
shortcut.addEventListener("mousedown", function (event) {
	event.preventDefault()
	shortcut.className = "shortcut on"
	var dx = event.clientX - shortcut.offsetLeft
	var dy = event.clientY - shortcut.offsetTop
	var box = ws_rect()
	track(function (e) {
		shortcut.style.left = Math.max(0, Math.min(box.w - shortcut.offsetWidth, e.clientX - dx)) + "px"
		shortcut.style.top = Math.max(0, Math.min(box.h - shortcut.offsetHeight, e.clientY - dy)) + "px"
	})
})
// Clicking the desktop itself drops the selection, as it does on a real one.
$("icons").addEventListener("mousedown", function (event) {
	if (event.target === $("icons")) shortcut.className = "shortcut"
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
	window.open("https://docs.postboi.email/dev-inbox", "_blank", "noopener")
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
				<li id="m-site"><span class="ico">&#127760;</span>postboi.email</li>
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
