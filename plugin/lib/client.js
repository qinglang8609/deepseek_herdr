window.__ModuleLoader__.load({
	id: "dsh-agent-commander",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);


//#region dsh-agent-commander css: dsh-agent-commander/panel.css
const panelCss = "/* dsh-agent-commander — Agent Radar panel styles (uses DSH design tokens) */\n/* Standard SVG icons (Lucide-style, stroke-based, currentColor). */\n.dhac_icon {\n\tflex: none;\n\tdisplay: inline-block;\n\tvertical-align: -0.125em;\n}\n.dhac_inlineIcon {\n\tvertical-align: -0.15em;\n\tmargin-right: 3px;\n}\n.dhac_spin {\n\tanimation: dhacSpin 1s linear infinite;\n}\n@keyframes dhacSpin {\n\tto {\n\t\ttransform: rotate(360deg);\n\t}\n}\n.dhac_toggleCluster {\n\tz-index: 2147483646;\n\tposition: fixed;\n\ttop: 10px;\n\tright: 12px;\n\tdisplay: flex;\n\tflex-direction: row;\n\tgap: 4px;\n\ttransition: right 0.18s var(--ds-ease-in-out, ease);\n}\n/* Desktop app: sit below the native title-bar strip so the button stays\n   clickable (the strip is a window drag region, not a button surface). */\nhtml[data-dsh-desktop=\"true\"] .dhac_toggleCluster {\n\ttop: calc(var(--dsh-desktop-titlebar-inset, 40px) + 8px);\n}\nbody[data-dsh-title-bar-compat] .dhac_toggleCluster {\n\ttop: calc(var(--dsh-title-bar-strip, 40px) + 8px);\n}\n.dhac_toggleButton {\n\t-webkit-app-region: no-drag;\n\theight: 32px;\n\tpadding: 0 12px;\n\tgap: 6px;\n\tcolor: var(--dsw-alias-label-secondary, #aaa);\n\tcursor: pointer;\n\tbackground: var(--dsw-alias-bg-layer-1, #222);\n\tborder: 1px solid var(--dsw-alias-border-l2, #555);\n\tborder-radius: 999px;\n\tjustify-content: center;\n\talign-items: center;\n\tdisplay: inline-flex;\n\tfont: var(--dsw-font-xxxs-strong-11);\n\tbox-shadow: 0 2px 10px rgba(0,0,0,0.35);\n\ttransition: background 0.15s, color 0.15s, transform 0.1s, border-radius 0.18s, width 0.18s;\n}\n.dhac_toggleIcon {\n\tdisplay: inline-flex;\n\talign-items: center;\n\tjustify-content: center;\n\tline-height: 1;\n}\n.dhac_toggleLabel {\n\twhite-space: nowrap;\n}\n.dhac_toggleButton:hover {\n\tbackground: var(--dsw-alias-interactive-bg-hover, #333);\n\tcolor: var(--dsw-alias-label-primary, #fff);\n\ttransform: scale(1.05);\n}\n.dhac_toggleButton:active {\n\ttransform: scale(0.95);\n}\n/* Panel open: compact icon-only circle docked to the details-column edge. */\n.dhac_toggleCluster_open .dhac_toggleButton {\n\twidth: 32px;\n\tpadding: 0;\n\tborder-radius: 50%;\n}\n.dhac_toggleCluster_open .dhac_toggleLabel {\n\tdisplay: none;\n}\n.dhac_root {\n\theight: 100%;\n\tmin-height: 0;\n\tbackground: var(--dsw-alias-bg-base);\n\tflex-direction: column;\n\tdisplay: flex;\n\tposition: relative;\n}\n.dhac_header {\n\tborder-bottom: 1px solid var(--dsw-alias-border-l1);\n\tbackground: var(--dsw-alias-bg-layer-1);\n\tflex: none;\n\talign-items: center;\n\tgap: 8px;\n\tmin-height: 38px;\n\tpadding: 0 8px 0 12px;\n\tdisplay: flex;\n}\n.dhac_headerTitle {\n\tmin-width: 0;\n\tfont: var(--dsw-font-xs-strong-13);\n\tcolor: var(--dsw-alias-label-primary);\n\twhite-space: nowrap;\n\tflex: 1;\n\toverflow: hidden;\n\ttext-overflow: ellipsis;\n}\n.dhac_workspace {\n\tborder-bottom: 1px solid var(--dsw-alias-border-l1);\n\tfont: var(--dsw-font-xxs-12);\n\tcolor: var(--dsw-alias-label-secondary);\n\twhite-space: nowrap;\n\tflex: none;\n\toverflow: hidden;\n\ttext-overflow: ellipsis;\n\tpadding: 3px 12px 5px;\n\tcursor: default;\n}\n.dhac_count {\n\tmin-width: 18px;\n\theight: 16px;\n\tfont: var(--dsw-font-xxxs-strong-11);\n\tcolor: var(--dsw-alias-label-secondary);\n\tbackground: var(--dsw-alias-interactive-bg-hover);\n\tborder-radius: 8px;\n\tflex: none;\n\tjustify-content: center;\n\talign-items: center;\n\tdisplay: inline-flex;\n\tpadding: 0 5px;\n}\n.dhac_iconButton {\n\twidth: 26px;\n\theight: 26px;\n\tcolor: var(--dsw-alias-label-secondary);\n\tcursor: pointer;\n\tbackground: none;\n\tborder: none;\n\tborder-radius: 6px;\n\tflex: none;\n\tjustify-content: center;\n\talign-items: center;\n\tpadding: 0;\n\tdisplay: inline-flex;\n\tfont-size: 14px;\n}\n.dhac_iconButton:hover:not(:disabled) {\n\tbackground: var(--dsw-alias-interactive-bg-hover);\n\tcolor: var(--dsw-alias-label-primary);\n}\n.dhac_iconButton:disabled {\n\topacity: 0.4;\n\tcursor: default;\n}\n.dhac_addButton {\n\tbackground: var(--dsw-alias-button-primary-fill);\n\theight: 24px;\n\tcolor: var(--dsw-alias-label-primary-inverted);\n\tfont: var(--dsw-font-xxs-strong-12);\n\tcursor: pointer;\n\tborder: none;\n\tborder-radius: 6px;\n\tflex: none;\n\talign-items: center;\n\tgap: 4px;\n\tpadding: 0 10px;\n\tdisplay: inline-flex;\n}\n.dhac_addButton:hover {\n\tbackground: var(--dsw-alias-button-primary-hover);\n}\n.dhac_body {\n\tflex: 1;\n\tmin-height: 0;\n\toverflow-y: auto;\n\tpadding: 4px 6px 8px;\n}\n.dhac_empty {\n\tfont: var(--dsw-font-xxs-12);\n\tcolor: var(--dsw-alias-label-tertiary);\n\ttext-align: center;\n\tjustify-content: center;\n\talign-items: center;\n\tgap: 6px;\n\tmin-height: 120px;\n\tflex-direction: column;\n\tdisplay: flex;\n\tpadding: 16px;\n}\n.dhac_emptyHint {\n\topacity: 0.85;\n}\n.dhac_agent {\n\tborder: 1px solid transparent;\n\tcursor: pointer;\n\ttext-align: left;\n\tbackground: none;\n\twidth: 100%;\n\tborder-radius: 8px;\n\tflex-direction: column;\n\talign-items: stretch;\n\tgap: 2px;\n\tmargin: 2px 0;\n\tpadding: 6px 8px;\n\tdisplay: flex;\n}\n.dhac_agent:hover {\n\tbackground: var(--dsw-alias-interactive-bg-hover);\n}\n.dhac_agentActive {\n\tbackground: var(--dsw-alias-interactive-bg-active);\n\tborder-color: var(--dsw-alias-border-l1);\n}\n.dhac_agentTop {\n\talign-items: center;\n\tgap: 6px;\n\tmin-width: 0;\n\tdisplay: flex;\n}\n.dhac_statusDot {\n\tborder-radius: 50%;\n\tflex: none;\n\twidth: 7px;\n\theight: 7px;\n}\n.dhac_statusDot[data-status=\"working\"] {\n\tbackground: var(--dsw-alias-state-warn-primary);\n\tbox-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, transparent);\n\tanimation: dhacPulse 1.6s ease-in-out infinite;\n}\n.dhac_statusDot[data-status=\"idle\"] {\n\tbackground: var(--dsw-alias-state-success-primary);\n}\n.dhac_statusDot[data-status=\"blocked\"] {\n\tbackground: var(--dsw-alias-state-error-primary);\n}\n.dhac_statusDot[data-status=\"closing\"] {\n\tbackground: var(--dsw-alias-label-tertiary);\n\tanimation: dhacPulse 1.2s ease-in-out infinite;\n}\n.dhac_statusDot[data-status=\"exited\"] {\n\tbackground: var(--dsw-alias-label-tertiary);\n}\n@keyframes dhacPulse {\n\t50% {\n\t\topacity: 0.35;\n\t}\n}\n.dhac_agentName {\n\tmin-width: 0;\n\tfont: var(--dsw-font-xxs-strong-12);\n\tcolor: var(--dsw-alias-label-primary);\n\twhite-space: nowrap;\n\tflex: 1;\n\toverflow: hidden;\n\ttext-overflow: ellipsis;\n}\n.dhac_agentType {\n\tfont: var(--dsw-font-xxxs-strong-11);\n\tcolor: var(--dsw-alias-label-tertiary);\n\tbackground: var(--dsw-alias-interactive-bg-hover);\n\tborder-radius: 4px;\n\tflex: none;\n\tpadding: 1px 5px;\n}\n.dhac_agentRole {\n\tfont: var(--dsw-font-xxxs-11);\n\tcolor: var(--dsw-alias-label-tertiary);\n\twhite-space: nowrap;\n\toverflow: hidden;\n\ttext-overflow: ellipsis;\n\tpadding-left: 13px;\n}\n.dhac_agentMeta {\n\tfont: var(--dsw-font-xxxs-11);\n\tcolor: var(--dsw-alias-label-tertiary);\n\tpadding-left: 13px;\n}\n.dhac_briefing {\n\tfont: var(--dsw-font-xxxs-11);\n\tcolor: var(--dsw-alias-state-warn-primary);\n\twhite-space: nowrap;\n\toverflow: hidden;\n\ttext-overflow: ellipsis;\n\tpadding-left: 13px;\n\tanimation: dhacPulse 1.6s ease-in-out infinite;\n}\n.dhac_briefingFailed {\n\tcolor: var(--dsw-alias-state-error-primary);\n\tanimation: none;\n}\n.dhac_toolbar {\n\tborder-bottom: 1px solid var(--dsw-alias-border-l1);\n\tbackground: var(--dsw-alias-bg-layer-1);\n\tflex: none;\n\talign-items: center;\n\tgap: 6px;\n\tmin-height: 36px;\n\tpadding: 0 8px;\n\tdisplay: flex;\n}\n.dhac_toolbarName {\n\tmin-width: 0;\n\tfont: var(--dsw-font-xxs-strong-12);\n\tcolor: var(--dsw-alias-label-primary);\n\twhite-space: nowrap;\n\tflex: 1;\n\toverflow: hidden;\n\ttext-overflow: ellipsis;\n}\n.dhac_terminalWrap {\n\tflex: 1;\n\tmin-height: 0;\n\tbackground: var(--dsw-alias-bg-base);\n\tflex-direction: column;\n\tdisplay: flex;\n\tposition: relative;\n}\n.dhac_terminal {\n\tflex: 1;\n\tmin-height: 0;\n\tpadding: 6px 4px 6px 8px;\n}\n.dhac_terminalBanner {\n\tfont: var(--dsw-font-xxxs-11);\n\tcolor: var(--dsw-alias-label-tertiary);\n\tbackground: var(--dsw-alias-bg-layer-1);\n\tborder-bottom: 1px solid var(--dsw-alias-border-l1);\n\tflex: none;\n\talign-items: center;\n\tgap: 6px;\n\tpadding: 2px 10px;\n\tdisplay: flex;\n}\n.dhac_termDot {\n\twidth: 7px;\n\theight: 7px;\n\tborder-radius: 50%;\n\tflex: none;\n\tbackground: var(--dsw-alias-label-tertiary);\n\tanimation: dhacPulse 1.2s ease-in-out infinite;\n}\n.dhac_termDotOn {\n\tbackground: var(--dsw-alias-state-success-primary);\n\tbox-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent);\n\tanimation: none;\n}\n/* ---- read-only tail view (replaces xterm rendering) ---- */\n.dhac_tailWrap {\n\tflex: 1;\n\tmin-height: 0;\n\tbackground: var(--dsw-alias-bg-base);\n\tflex-direction: column;\n\tdisplay: flex;\n\tposition: relative;\n}\n.dhac_tail {\n\tflex: 1;\n\tmin-height: 0;\n\tmargin: 0;\n\tpadding: 6px 8px;\n\toverflow: auto;\n\tfont: var(--dsw-font-xs-12) ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;\n\tline-height: 1.5;\n\tcolor: var(--dsw-alias-label-primary);\n\twhite-space: pre-wrap;\n\tword-break: break-all;\n\tuser-select: text;\n}\n.dhac_tailWrapCompact {\n\theight: 148px;\n\tflex: none;\n\tpadding: 2px 4px 2px 6px;\n}\n.dhac_termBody {\n\tflex: 1;\n\tmin-height: 0;\n\tflex-direction: column;\n\tdisplay: flex;\n}\n.dhac_sendBox {\n\tflex: none;\n\tdisplay: flex;\n\tgap: 6px;\n\tpadding: 6px 8px;\n\tborder-top: 1px solid var(--dsw-alias-border-l1);\n\tbackground: var(--dsw-alias-bg-layer-1);\n}\n.dhac_sendBox .dhac_input {\n\tflex: 1;\n}\n.dhac_terminalHint {\n\topacity: 0.7;\n\tfont: var(--dsw-font-xxxs-11);\n}\n/* ---- herdr host badge & workspace space tag ---- */\n.dhac_hostBadge {\n\tfont: var(--dsw-font-xxxs-11);\n\tcolor: var(--dsw-alias-label-tertiary);\n\tbackground: var(--dsw-alias-bg-layer-1);\n\tborder: 1px solid var(--dsw-alias-border-l1);\n\tborder-radius: 999px;\n\tpadding: 1px 8px;\n\twhite-space: nowrap;\n}\n.dhac_hostBadgeOn {\n\tcolor: var(--dsw-alias-state-success-primary);\n\tborder-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent);\n}\n.dhac_herdrSpaceTag {\n\tdisplay: inline-flex;\n\talign-items: center;\n\tgap: 3px;\n\tcolor: var(--dsw-alias-state-info-primary, var(--dsw-alias-label-secondary));\n\tfont: var(--dsw-font-xxxs-11);\n\twhite-space: nowrap;\n}\n.dhac_herdrSpace {\n\tdisplay: flex;\n\talign-items: flex-start;\n\tgap: 5px;\n\tline-height: 1.5;\n}\n.dhac_herdrSpaceNew {\n\tcolor: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-secondary));\n}\n.dhac_modal {\n\tposition: fixed;\n\tinset: 0;\n\tz-index: 1000;\n\tbackground: rgb(0 0 0 / 45%);\n\tjustify-content: center;\n\talign-items: center;\n\tdisplay: flex;\n}\n.dhac_dialog {\n\tbackground: var(--dsw-alias-bg-layer-1);\n\tborder: 1px solid var(--dsw-alias-border-l2);\n\tbox-shadow: var(--dsw-shadow-lv3);\n\twidth: min(440px, calc(100vw - 48px));\n\tmax-height: calc(100vh - 96px);\n\tborder-radius: 12px;\n\tflex-direction: column;\n\tdisplay: flex;\n\toverflow: hidden;\n}\n.dhac_dialogTitle {\n\tfont: var(--dsw-font-s-strong-14);\n\tcolor: var(--dsw-alias-label-primary);\n\tflex: none;\n\tpadding: 14px 16px 8px;\n}\n.dhac_dialogBody {\n\tflex: 1;\n\tmin-height: 0;\n\tgap: 10px;\n\toverflow-y: auto;\n\tflex-direction: column;\n\tdisplay: flex;\n\tpadding: 4px 16px 12px;\n}\n.dhac_field {\n\tflex-direction: column;\n\tgap: 4px;\n\tdisplay: flex;\n}\n.dhac_fieldLabel {\n\tfont: var(--dsw-font-xxs-strong-12);\n\tcolor: var(--dsw-alias-label-secondary);\n}\n.dhac_input,\n.dhac_textarea,\n.dhac_select {\n\tborder: 1px solid var(--dsw-alias-border-l1);\n\tbackground: var(--dsw-alias-bg-base);\n\twidth: 100%;\n\tcolor: var(--dsw-alias-label-primary);\n\tfont: var(--dsw-font-xxs-12);\n\tborder-radius: 6px;\n\tpadding: 6px 8px;\n\tbox-sizing: border-box;\n}\n.dhac_input:focus,\n.dhac_textarea:focus,\n.dhac_select:focus {\n\tborder-color: var(--dsw-alias-border-l2);\n\toutline: none;\n}\n.dhac_textarea {\n\tmin-height: 64px;\n\tresize: vertical;\n\tline-height: 1.5;\n}\n.dhac_presets {\n\tflex-wrap: wrap;\n\talign-items: center;\n\tgap: 4px;\n\tdisplay: flex;\n}\n.dhac_preset {\n\tborder: 1px solid var(--dsw-alias-border-l2);\n\tbackground: var(--dsw-alias-bg-layer-2);\n\tcolor: var(--dsw-alias-label-secondary);\n\tfont: var(--dsw-font-xxxs-11);\n\tcursor: pointer;\n\tborder-radius: 999px;\n\tflex: none;\n\tpadding: 2px 8px;\n}\n.dhac_preset:hover {\n\tbackground: var(--dsw-alias-interactive-bg-hover);\n\tcolor: var(--dsw-alias-label-primary);\n}\n.dhac_skills {\n\tflex-wrap: wrap;\n\tgap: 4px;\n\tmax-height: 96px;\n\talign-items: center;\n\toverflow-y: auto;\n\tdisplay: flex;\n}\n.dhac_skill {\n\tborder: 1px solid var(--dsw-alias-border-l2);\n\tbackground: var(--dsw-alias-bg-layer-2);\n\tcolor: var(--dsw-alias-label-secondary);\n\tfont: var(--dsw-font-xxxs-11);\n\tcursor: pointer;\n\tborder-radius: 6px;\n\tflex: none;\n\talign-items: center;\n\tgap: 4px;\n\tpadding: 2px 8px;\n\tdisplay: inline-flex;\n}\n.dhac_skillSelected {\n\tbackground: var(--dsw-alias-interactive-bg-active);\n\tcolor: var(--dsw-alias-label-primary);\n\tborder-color: var(--dsw-alias-border-l2);\n}\n.dhac_skill input {\n\taccent-color: var(--dsw-alias-brand-primary);\n\tmargin: 0;\n}\n.dhac_dialogActions {\n\tborder-top: 1px solid var(--dsw-alias-border-l1);\n\tflex: none;\n\talign-items: center;\n\tgap: 8px;\n\tjustify-content: flex-end;\n\tpadding: 10px 16px;\n\tdisplay: flex;\n}\n.dhac_btn {\n\tborder: 1px solid var(--dsw-alias-border-l2);\n\tbackground: var(--dsw-alias-bg-layer-2);\n\theight: 28px;\n\tcolor: var(--dsw-alias-label-primary);\n\tfont: var(--dsw-font-xxs-strong-12);\n\tcursor: pointer;\n\tborder-radius: 6px;\n\tflex: none;\n\tpadding: 0 14px;\n}\n.dhac_btn:hover:not(:disabled) {\n\tbackground: var(--dsw-alias-interactive-bg-hover);\n}\n.dhac_btn:disabled {\n\topacity: 0.45;\n\tcursor: default;\n}\n.dhac_btnPrimary {\n\tbackground: var(--dsw-alias-button-primary-fill);\n\tborder-color: transparent;\n\tcolor: var(--dsw-alias-label-primary-inverted);\n}\n.dhac_btnPrimary:hover:not(:disabled) {\n\tbackground: var(--dsw-alias-button-primary-hover);\n}\n.dhac_error {\n\tfont: var(--dsw-font-xxs-12);\n\tcolor: var(--dsw-alias-state-error-primary);\n}\n.dhac_hint {\n\tfont: var(--dsw-font-xxxs-11);\n\tcolor: var(--dsw-alias-label-tertiary);\n\tline-height: 1.5;\n}\n\n/* ---- live terminal cards ---- */\n.dhac_cards {\n\tflex-direction: column;\n\tgap: 8px;\n\tdisplay: flex;\n}\n.dhac_card {\n\tborder: 1px solid var(--dsw-alias-border-l1);\n\tbackground: var(--dsw-alias-bg-layer-1);\n\tcursor: pointer;\n\tborder-radius: 8px;\n\tflex-direction: column;\n\tmin-width: 0;\n\tdisplay: flex;\n\toverflow: hidden;\n}\n.dhac_card:hover {\n\tborder-color: var(--dsw-alias-border-l2);\n}\n.dhac_cardHeader {\n\talign-items: center;\n\tgap: 6px;\n\tmin-width: 0;\n\tflex: none;\n\tpadding: 4px 6px 4px 8px;\n\tborder-bottom: 1px solid var(--dsw-alias-border-l1);\n\tdisplay: flex;\n}\n.dhac_cardClose {\n\twidth: 20px;\n\theight: 20px;\n\tcolor: var(--dsw-alias-label-tertiary);\n\tcursor: pointer;\n\tbackground: none;\n\tborder: none;\n\tborder-radius: 4px;\n\tflex: none;\n\tjustify-content: center;\n\talign-items: center;\n\tpadding: 0;\n\tdisplay: inline-flex;\n\tfont-size: 11px;\n}\n.dhac_cardClose:hover {\n\tbackground: var(--dsw-alias-interactive-bg-hover);\n\tcolor: var(--dsw-alias-label-primary);\n}\n.dhac_miniTermWrap {\n\theight: 148px;\n\tflex: none;\n\tpadding: 2px 4px 2px 6px;\n\tposition: relative;\n}\n.dhac_miniTerm {\n\twidth: 100%;\n\theight: 100%;\n}\n.dhac_cardExited {\n\theight: 148px;\n\tflex: none;\n\tfont: var(--dsw-font-xxs-12);\n\tcolor: var(--dsw-alias-label-tertiary);\n\tjustify-content: center;\n\talign-items: center;\n\tdisplay: flex;\n}\n.dhac_terminalDead {\n\tflex: 1;\n\tmin-height: 0;\n\tfont: var(--dsw-font-xxs-12);\n\tcolor: var(--dsw-alias-label-tertiary);\n\tjustify-content: center;\n\talign-items: center;\n\tgap: 8px;\n\tflex-direction: column;\n\tdisplay: flex;\n\tpadding: 16px;\n\ttext-align: center;\n}\n.dhac_terminalDeadHint {\n\topacity: 0.85;\n}\n\n/* ---- resize handle + status toasts ---- */\n.dhac_resizeHandle {\n\tcursor: col-resize;\n\ttouch-action: none;\n\tz-index: 3;\n\twidth: 8px;\n\tposition: absolute;\n\ttop: 0;\n\tbottom: 0;\n\tleft: -4px;\n}\n.dhac_resizeHandle:hover,\n.dhac_resizeHandle:active {\n\tbackground: var(--dsw-alias-interactive-bg-hover-accent);\n}\n.dhac_toasts {\n\tz-index: 30;\n\tpointer-events: none;\n\tgap: 6px;\n\tflex-direction: column;\n\talign-items: center;\n\tdisplay: flex;\n\tposition: absolute;\n\tbottom: 12px;\n\tleft: 8px;\n\tright: 8px;\n}\n.dhac_toast {\n\tpointer-events: auto;\n\tfont: var(--dsw-font-xxs-12);\n\tcolor: var(--dsw-alias-label-primary);\n\tbackground: var(--dsw-alias-bg-layer-2);\n\tborder: 1px solid var(--dsw-alias-border-l2);\n\tbox-shadow: var(--dsw-shadow-lv1);\n\tmax-width: 100%;\n\tborder-radius: 8px;\n\tpadding: 6px 10px;\n\twhite-space: normal;\n}\n.dhac_toast_done {\n\tborder-color: var(--dsw-alias-state-success-primary);\n}\n.dhac_toast_exit {\n\tborder-color: var(--dsw-alias-label-tertiary);\n}\n.dhac_toast_create {\n\tborder-color: var(--dsw-alias-state-business-primary);\n}\n\n/* ---- cache dialog ---- */\n.dhac_cacheRow {\n\tborder: 1px solid var(--dsw-alias-border-l1);\n\tbackground: var(--dsw-alias-bg-base);\n\tborder-radius: 8px;\n\tflex-direction: column;\n\tgap: 2px;\n\tpadding: 8px 10px;\n\tdisplay: flex;\n}\n.dhac_cachePaths {\n\tflex-direction: column;\n\tgap: 1px;\n\tdisplay: flex;\n}\n.dhac_cachePath {\n\tfont: var(--dsw-font-xxxs-11);\n\tcolor: var(--dsw-alias-label-tertiary);\n\tword-break: break-all;\n}\n";
const panelCssTagId = "dsh-agent-commander/panel.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(panelCssTagId) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-agent-commander";
	tag.dataset.pluginCss = panelCssTagId;
	tag.textContent = panelCss;
	document.head.appendChild(tag);
}
//#endregion

// ============================================================================
// dsh-agent-commander — client application (plain JS + React createElement)
//
// Registers the "Agent Radar" panel into the app's real right "details"
// column (no floating overlay):
//   • list every open agent with live status (working / idle / blocked / exited)
//   • click an agent to open its read-only output tail + send box (plain <pre>,
//     no xterm — output streams via the terminal WebSocket, input via REST)
//   • herdr host badge + current workspace's herdr space tag
//   • "+ 新建智能体" dialog: engine (herdr kinds / legacy types), name, role
//     definition with presets, skill attachments, working directory; in herdr
//     mode shows the target herdr space (auto-created on create when missing)
//
// Details-column caveat: AppFrame only gives the details track a width when
// the current session is non-blank. A width-enforcement effect takes over the
// last grid track ONLY when the app left it at 0 (blank/fresh session), so the
// panel is a real column in every state; when the app itself opens the column
// (non-blank session, drag resize) its value is respected.
// ============================================================================
const { useEffect, useState, useRef, useCallback } = react;
const h = react.createElement;

// ---------------------------------------------------------------------------
// Standard icon set — inline Lucide-style SVGs (stroke-based, currentColor).
// Self-contained so the single-file client bundle needs no icon dependency.
// Each entry: name → array of [tagName, attrs] describing the 24×24 glyph.
// ---------------------------------------------------------------------------
const ICON_PATHS = {
	"x": [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
	"power": [["path", { d: "M12 2v10" }], ["path", { d: "M18.4 6.6a9 9 0 1 1-12.77.04" }]],
	"rotate-ccw": [["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }], ["path", { d: "M3 3v5h5" }]],
	"refresh-cw": [["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }], ["path", { d: "M21 3v5h-5" }], ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }], ["path", { d: "M8 16H3v5" }]],
	"minimize": [["path", { d: "m14 10 7-7" }], ["path", { d: "M20 10h-6V4" }], ["path", { d: "m3 21 7-7" }], ["path", { d: "M4 14h6v6" }]],
	"folder": [["path", { d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }]],
	"clock": [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "M12 6v6l4 2" }]],
	"alert": [["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }], ["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }]],
	"chevron-left": [["path", { d: "m15 18-6-6 6-6" }]],
	"plus": [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
	"stop": [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2, fill: "currentColor", stroke: "none" }]],
	"bot": [["path", { d: "M12 8V4H8" }], ["rect", { width: 16, height: 12, x: 4, y: 8, rx: 2 }], ["path", { d: "M2 14h2" }], ["path", { d: "M20 14h2" }], ["path", { d: "M15 13v2" }], ["path", { d: "M9 13v2" }]],
	"layout": [["rect", { width: 7, height: 7, x: 3, y: 3, rx: 1 }], ["rect", { width: 7, height: 7, x: 14, y: 3, rx: 1 }], ["rect", { width: 7, height: 7, x: 14, y: 14, rx: 1 }], ["rect", { width: 7, height: 7, x: 3, y: 14, rx: 1 }]]
};

function Icon({ name, size = 14, className = "" }) {
	const parts = ICON_PATHS[name] || [];
	if (parts.length === 0) return null;
	return h("svg", {
		className: `dhac_icon${className ? " " + className : ""}`,
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 2,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": "true"
	}, parts.map(([tag, attrs], i) => h(tag, { key: i, ...attrs })));
}

// HTML string variant for imperatively-built DOM (toggle button).
function iconSvgMarkup(name, size = 15) {
	const parts = ICON_PATHS[name] || [];
	const inner = parts.map(([tag, attrs]) => {
		const attrStr = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ");
		return `<${tag} ${attrStr}></${tag}>`;
	}).join("");
	return `<svg class="dhac_icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
const API_BASE = "/agent-commander/api";
async function apiGet(path) {
	const res = await fetch(API_BASE + path, { headers: { accept: "application/json" } });
	const body = await res.json().catch(() => null);
	if (!res.ok || body?.ok !== true) throw new Error(body?.error?.message || `HTTP ${res.status}`);
	return body.value;
}
async function apiPost(path, payload) {
	const res = await fetch(API_BASE + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload ?? {})
	});
	const body = await res.json().catch(() => null);
	if (!res.ok || body?.ok !== true) throw new Error(body?.error?.message || `HTTP ${res.status}`);
	return body.value;
}
async function apiDelete(path) {
	const res = await fetch(API_BASE + path, { method: "DELETE" });
	const body = await res.json().catch(() => null);
	if (!res.ok || body?.ok !== true) throw new Error(body?.error?.message || `HTTP ${res.status}`);
	return body.value;
}
function wsUrl(path) {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${location.host}${path}`;
}

// ---------------------------------------------------------------------------
// Agent snapshot store (module level — shared across mounts)
// ---------------------------------------------------------------------------
const agentListeners = new Set();
let agentSnapshot = [];
let listWs = null;
let listCwd = void 0;
function setAgents(next) {
	agentSnapshot = Array.isArray(next) ? next : [];
	for (const fn of [...agentListeners]) fn(agentSnapshot);
}
function getAgents() {
	return agentSnapshot;
}
let subscriberCount = 0;
function subscribeAgents(fn) {
	subscriberCount++;
	agentListeners.add(fn);
	fn(agentSnapshot);
	return () => {
		agentListeners.delete(fn);
		subscriberCount--;
		if (subscriberCount === 0 && listWs !== null) {
			try { listWs.close(); } catch {}
			listWs = null;
		}
	};
}
/** Scope the pushed agent list to a workspace folder and reconnect the WS.
 * Called whenever the current session's working directory changes, so the
 * radar only ever shows (and live-updates) THIS folder's agents. */
function setListCwd(cwd) {
	const next = typeof cwd === "string" && cwd !== "" ? cwd : void 0;
	if (next === listCwd) return;
	listCwd = next;
	if (listWs !== null) {
		try {
			listWs.close();
		} catch {}
		listWs = null;
	}
	connectListWs();
}
let connecting = false;
function connectListWs() {
	if (connecting) return;
	if (listWs !== null && (listWs.readyState === WebSocket.CONNECTING || listWs.readyState === WebSocket.OPEN)) return;
	connecting = true;
	let ws;
	const open = () => {
		if (listWs !== null && (listWs.readyState === WebSocket.CONNECTING || listWs.readyState === WebSocket.OPEN)) {
			connecting = false;
			return;
		}
		const qs = listCwd !== void 0 ? `?cwd=${encodeURIComponent(listCwd)}` : "";
		ws = new WebSocket(wsUrl(`/agent-commander/ws/list${qs}`));
		listWs = ws;
		ws.onmessage = (e) => {
			try {
				setAgents(JSON.parse(e.data));
			} catch {}
		};
		ws.onclose = () => {
			if (listWs === ws) listWs = null;
			connecting = false;
			setTimeout(open, 2000);
		};
		ws.onerror = () => {
			try {
				ws.close();
			} catch {}
		};
	};
	open();
}

// ---------------------------------------------------------------------------
// Status labels
// ---------------------------------------------------------------------------
const STATUS_LABEL = {
	working: "工作中",
	idle: "空闲",
	blocked: "受阻",
	closing: "退出中…",
	exited: "已退出",
	unknown: "未知"
};

// ---------------------------------------------------------------------------
// Details-column width enforcement.
//
// The AppFrame grid track for the details column stays 0 while the current
// session is blank. We watch the frame and take over the LAST track only when
// the app itself left it at 0 — this keeps the radar a REAL sidebar column on
// blank sessions without fighting drag-resize / natural widths otherwise.
// ---------------------------------------------------------------------------
const PANEL_WIDTH_KEY = "dsh-agent-commander.panelWidth";
const PANEL_WIDTH_DEFAULT = 380;
const PANEL_COLLAPSED_KEY = "dsh-agent-commander.panelCollapsed";
function isPanelCollapsed() {
	try { return localStorage.getItem(PANEL_COLLAPSED_KEY) === "1"; }
	catch { return false; }
}
function setPanelCollapsed(collapsed) {
	try {
		if (collapsed) localStorage.setItem(PANEL_COLLAPSED_KEY, "1");
		else localStorage.removeItem(PANEL_COLLAPSED_KEY);
	} catch {}
}

function useDetailsColumn() {
	const rootRef = useRef(null);
	const [width, setWidth] = useState(() => {
		try {
			const w = Number(localStorage.getItem(PANEL_WIDTH_KEY));
			return Number.isFinite(w) && w >= 280 && w <= 620 ? w : PANEL_WIDTH_DEFAULT;
		} catch {
			return PANEL_WIDTH_DEFAULT;
		}
	});
	const stateRef = useRef({ width });
	stateRef.current = { width };

	useEffect(() => {
		try {
			const root = rootRef.current;
			if (root === null) return;
			const column = root.parentElement;
			const frame = column?.parentElement;
			if (frame === null || frame === void 0) return;
			let raf = 0;
			const enforce = () => {
				raf = 0;
				try {
					if (isPanelCollapsed()) return;
					const w = stateRef.current.width;
					const style = frame.style.gridTemplateColumns;
					if (typeof style !== "string" || style === "") return;
					const last = style.match(/(\S+)\s*$/)?.[1];
					if (last === "0px" || last === "0") {
						frame.style.gridTemplateColumns = style.replace(/(\S+)\s*$/, `${w}px`);
						frame.removeAttribute("data-details-collapsed");
					}
				} catch {}
			};
			const schedule = () => {
				if (raf === 0) raf = requestAnimationFrame(enforce);
			};
			schedule();
			return () => {
				if (raf !== 0) cancelAnimationFrame(raf);
			};
		} catch {}
	}, [width]);

	useEffect(() => {
		try {
			localStorage.setItem(PANEL_WIDTH_KEY, String(width));
		} catch {}
	}, [width]);

	const onDragStart = useCallback((e) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = width;
		const onMove = (ev) => {
			const w = Math.min(620, Math.max(280, startW + (startX - ev.clientX)));
			setWidth(w);
			try {
				const column = rootRef.current?.parentElement;
				const frame = column?.parentElement;
				if (frame) {
					const style = frame.style.gridTemplateColumns;
					if (typeof style === "string" && style !== "") frame.style.gridTemplateColumns = style.replace(/(\S+)\s*$/, `${w}px`);
				}
			} catch {}
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, [width, rootRef]);

	return { rootRef, onDragStart };
}

// ---------------------------------------------------------------------------
// Terminal view (vendored xterm + addon-fit + WebSocket bridge)
// ---------------------------------------------------------------------------
const AGENT_TYPES = ["claude", "opencode", "codex", "codebuddy", "pi", "qwen"];
const COMPACT_SUPPORTED = new Set(["claude", "codebuddy", "qwen"]);
const DEFAULT_ROLE_PRESETS = ["数据库专家", "设计专家", "前端专家", "测试专家", "代码审查专家", "架构师"];

// ---------------------------------------------------------------------------
// Runtime config (mirror of the server-side Config schema, fetched lazily).
// The 新建智能体 dialog uses server-configured rolePresets when available,
// falling back to the built-in presets — so a user can add presets from
// cordis.yml without touching client code (plugin standard: no hardcoded
// tunables). Also exposes agentTypes/limits for other client plugins.
// ---------------------------------------------------------------------------
let pluginConfig = null;
let pluginConfigPromise = null;
function getPluginConfig() {
	if (pluginConfigPromise === null) {
		pluginConfigPromise = apiGet("/config").then((value) => {
			pluginConfig = value?.config ?? null;
			return pluginConfig;
		}).catch(() => {
			pluginConfig = null;
			return null;
		});
	}
	return pluginConfigPromise;
}
function getRolePresets() {
	return (pluginConfig !== null && Array.isArray(pluginConfig.rolePresets) && pluginConfig.rolePresets.length > 0)
		? pluginConfig.rolePresets
		: DEFAULT_ROLE_PRESETS;
}

// ---------------------------------------------------------------------------
// TailView — lightweight read-only agent output (plain <pre>, NO xterm).
//
// Connects to the same terminal WebSocket; in herdr mode the backend serves a
// 1.5s poll of `herdr agent read` (plain text), in legacy mode the raw PTY
// stream. Renders text with ANSI stripped into a <pre> and caps the buffer —
// this replaces the xterm rendering that froze the sidebar on long sessions.
// Input happens in herdr / via the detail view's send box (REST), not here.
// ---------------------------------------------------------------------------
function stripAnsi(text) {
	// eslint-disable-next-line no-control-regex
	return String(text ?? "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function TailView({ agentId, compact }) {
	const preRef = useRef(null);
	const bufferRef = useRef("");
	const [connected, setConnected] = useState(false);

	useEffect(() => {
		bufferRef.current = "";
		const pre = preRef.current;
		const MAX = compact === true ? 48 * 1024 : 256 * 1024;
		let closed = false;
		let ws = null;
		let retry = 0;
		let reconnectTimer = null;
		let raf = 0;
		const render = () => {
			if (pre !== null) pre.textContent = bufferRef.current;
			if (pre !== null) pre.scrollTop = pre.scrollHeight;
		};
		const scheduleRender = () => {
			if (raf !== 0) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				render();
			});
		};
		const append = (text) => {
			let next = bufferRef.current + text;
			if (next.length > MAX) next = next.slice(-MAX);
			bufferRef.current = next;
			scheduleRender();
		};
		const connect = () => {
			if (closed) return;
			ws = new WebSocket(wsUrl(`/agent-commander/ws/terminal?id=${encodeURIComponent(agentId)}`));
			ws.onopen = () => {
				retry = 0;
				setConnected(true);
			};
			ws.onmessage = (e) => {
				const write = (text) => append(stripAnsi(text));
				if (typeof e.data === "string") write(e.data);
				else e.data.text().then(write).catch(() => {});
			};
			ws.onclose = () => {
				setConnected(false);
				if (closed) return;
				retry = Math.min(retry + 1, 6);
				reconnectTimer = setTimeout(connect, 500 * 2 ** retry);
			};
			ws.onerror = () => {
				try {
					ws.close();
				} catch {}
			};
		};
		connect();
		return () => {
			closed = true;
			if (reconnectTimer !== null) clearTimeout(reconnectTimer);
			if (raf !== 0) cancelAnimationFrame(raf);
			try {
				ws?.close();
			} catch {}
		};
	}, [agentId, compact]);

	return h("div", { className: compact === true ? "dhac_tailWrap dhac_tailWrapCompact" : "dhac_tailWrap" }, [
		h("div", { className: "dhac_terminalBanner" }, [
			h("span", { className: `dhac_termDot${connected ? " dhac_termDotOn" : ""}` }),
			h("span", null, connected ? "实时输出" : "连接中…"),
			h("span", { style: { flex: "1" } }),
			compact !== true && h("span", { className: "dhac_terminalHint" }, "输入请用下方发送框（在 herdr 中执行）")
		]),
		h("pre", { ref: preRef, className: "dhac_tail" })
	]);
}

// ---------------------------------------------------------------------------
// New-agent dialog
// ---------------------------------------------------------------------------
function NewAgentDialog({ sessionId, sessionName, workspaceId, defaultCwd, onClose, onCreated }) {
	const [type, setType] = useState("opencode");
	const [name, setName] = useState("");
	const [role, setRole] = useState("");
	const [skills, setSkills] = useState([]);
	const [cwd, setCwd] = useState(defaultCwd ?? "");
	const [binaries, setBinaries] = useState([]);
	const [availableSkills, setAvailableSkills] = useState([]);
	const [rolePresets, setRolePresets] = useState(DEFAULT_ROLE_PRESETS);
	const [herdrSpace, setHerdrSpace] = useState(null);
	const [herdrMode, setHerdrMode] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);

	useEffect(() => {
		apiGet("/binaries").then((value) => setBinaries(value?.binaries ?? [])).catch(() => {});
		apiGet("/skills").then((value) => {
			const list = value?.skills ?? [];
			setAvailableSkills(list);
			setSkills(list.map((s) => s.path));
		}).catch(() => {});
		getPluginConfig().then(() => {
			setRolePresets(getRolePresets());
			setHerdrMode(pluginConfig?.herdrMode === true);
		});
	}, []);

	// herdr 模式：显示目标工作目录对应的 herdr 空间（不存在则提示自动新建）。
	useEffect(() => {
		if (typeof cwd !== "string" || cwd === "") {
			setHerdrSpace(null);
			return;
		}
		let cancelled = false;
		apiGet(`/herdr/workspace?cwd=${encodeURIComponent(cwd)}`).then((value) => {
			if (!cancelled) setHerdrSpace(value?.workspace ?? null);
		}).catch(() => {});
		return () => { cancelled = true; };
	}, [cwd]);

	const toggleSkill = (path) => {
		setSkills((current) => (current.includes(path) ? current.filter((p) => p !== path) : [...current, path]));
	};
	const engines = herdrMode && Array.isArray(pluginConfig?.herdrKinds) && pluginConfig.herdrKinds.length > 0
		? pluginConfig.herdrKinds
		: AGENT_TYPES;
	const submit = async () => {
		if (busy) return;
		if (type === "") {
			setError(`请选择智能体引擎（${engines.join(" / ")}）`);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const body = await apiPost("/agents", { sessionId, sessionName, workspaceId, type, name, role, skills, cwd });
			onCreated(body.agent);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return h("div", { className: "dhac_modal", onClick: (e) => { if (e.target === e.currentTarget) onClose(); } }, [
		h("div", { className: "dhac_dialog" }, [
			h("div", { className: "dhac_dialogTitle" }, herdrMode ? "新建智能体（herdr 空间）" : "新建智能体"),
			h("div", { className: "dhac_dialogBody" }, [
				h("div", { className: "dhac_field" }, [
					h("label", { className: "dhac_fieldLabel" }, "引擎类型"),
					h("select", { className: "dhac_select", value: type, onChange: (e) => setType(e.target.value) },
						engines.map((t) => {
							const info = binaries.find((b) => b.type === t);
							const available = herdrMode ? true : info?.available === true;
							return h("option", { key: t, value: t, disabled: !available }, available ? t : `${t}（未安装）`);
						}))
				]),
				h("div", { className: "dhac_field" }, [
					h("label", { className: "dhac_fieldLabel" }, "智能体名称"),
					h("input", { className: "dhac_input", value: name, placeholder: `默认：${type}`, onChange: (e) => setName(e.target.value) })
				]),
				h("div", { className: "dhac_field" }, [
					h("label", { className: "dhac_fieldLabel" }, "角色定义（注入给该智能体的开场简报）"),
					h("div", { className: "dhac_presets" },
						rolePresets.map((preset) =>
							h("button", { key: preset, type: "button", className: "dhac_preset", onClick: () => setRole(preset) }, preset))),
					h("textarea", {
						className: "dhac_textarea",
						value: role,
						placeholder: "例：你负责数据库设计与 SQL 优化，精通 PostgreSQL；独立完成表结构评审与慢查询分析。",
						onChange: (e) => setRole(e.target.value)
					})
				]),
				h("div", { className: "dhac_field" }, [
					h("label", { className: "dhac_fieldLabel" }, "挂载技能（该智能体开工前必读）"),
					availableSkills.length === 0
						? h("div", { className: "dhac_hint" }, "未在 ~/.agents/skills 发现技能")
						: h("div", { className: "dhac_skills" },
							availableSkills.map((s) =>
								h("label", { key: s.name, className: `dhac_skill${skills.includes(s.path) ? " dhac_skillSelected" : ""}` }, [
									h("input", {
										type: "checkbox",
										checked: skills.includes(s.path),
										onChange: () => toggleSkill(s.path)
									}),
									s.name
								])))
				]),
				h("div", { className: "dhac_field" }, [
					h("label", { className: "dhac_fieldLabel" }, "工作目录"),
					h("input", { className: "dhac_input", value: cwd, placeholder: "默认：当前会话目录", onChange: (e) => setCwd(e.target.value) })
				]),
				herdrMode && h("div", { className: `dhac_hint dhac_herdrSpace${herdrSpace ? "" : " dhac_herdrSpaceNew"}` }, [
					h(Icon, { name: herdrSpace ? "layout" : "plus", size: 11, className: "dhac_inlineIcon" }),
					herdrSpace
						? `herdr 空间 ${herdrSpace.workspaceId}（${herdrSpace.label}，${herdrSpace.paneCount} 面板）— 将复用并在其中新建智能体面板`
						: "该目录暂无 herdr 空间 — 创建时将在 herdr 中自动新建空间与面板，并注入角色/技能简报"
				]),
				error !== null && h("div", { className: "dhac_error" }, error),
				h("div", { className: "dhac_hint" }, herdrMode
					? "智能体将运行在 herdr 后台 server（断开/重启不丢）。新建后会读取工作目录 .deepseek/ 下的 memory.md / task-board.md / experience.md，并遵循团队协作协议（完成后更新 task-board、产出写入 handoffs/、经验沉淀到 experience.md）。"
					: "新建后该智能体会读取工作目录 .deepseek/ 下的 memory.md / task-board.md / experience.md，并遵循团队协作协议（完成后更新 task-board、产出写入 handoffs/、经验沉淀到 experience.md）。")
			]),
			h("div", { className: "dhac_dialogActions" }, [
				h("button", { type: "button", className: "dhac_btn", onClick: onClose, disabled: busy }, "取消"),
				h("button", { type: "button", className: "dhac_btn dhac_btnPrimary", onClick: submit, disabled: busy }, busy ? "创建中…" : "创建并启动")
			])
		])
	]);
}

// ---------------------------------------------------------------------------
// Mini live tail card (compact read-only TailView on each agent card)
// ---------------------------------------------------------------------------
function MiniTerminal({ agentId }) {
	return h(TailView, { agentId, compact: true });
}

// ---------------------------------------------------------------------------
// Agent cards (live mini-terminal per agent)
// ---------------------------------------------------------------------------
function AgentCards({ agents, scoped, onOpen, onCompact, onNewSession, onCloseAgent, onRestore, onForget }) {
	if (agents.length === 0) {
		return h("div", { className: "dhac_empty" }, [
			h("div", null, scoped ? "本文件夹还没有智能体" : "还没有智能体"),
			h("div", { className: "dhac_emptyHint" }, "点击右上角「新建」打开 claude / opencode / codex，或让 DeepSeek 用 agent_open 工具创建"),
			h("div", { className: "dhac_emptyHint" }, "智能体共享记忆：.deepseek/memory.md · task-board.md · experience.md · handoffs/")
		]);
	}
	return h("div", { className: "dhac_cards" }, agents.map((agent) => {
		const ghost = agent.running === false;
		return h("div", {
			key: agent.id,
			className: "dhac_card",
			onClick: () => onOpen(agent)
		}, [
			h("div", { className: "dhac_cardHeader" }, [
				h("span", { className: "dhac_statusDot", "data-status": ghost ? "exited" : agent.status }),
				h("span", { className: "dhac_agentName", title: agent.role || agent.cwd }, agent.name),
				h("span", { className: "dhac_agentType" }, agent.type),
				h("span", { className: "dhac_agentMeta" }, ghost ? "已保存·未运行" : (STATUS_LABEL[agent.status] ?? agent.status)),
				ghost
					? h("span", { style: { display: "contents" } }, [
						h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "重新启动该智能体（恢复会话）",
							onClick: (e) => {
								e.stopPropagation();
								onRestore(agent.id);
							}
						}, h(Icon, { name: "power", size: 12 })),
						h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "删除该保存记录（从 .deepseek/agents.json 移除）",
							onClick: (e) => {
								e.stopPropagation();
								onForget(agent.id);
							}
						}, h(Icon, { name: "x", size: 12 }))
					])
					: h("span", { style: { display: "contents" } }, [
						COMPACT_SUPPORTED.has(agent.type) && h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "压缩会话（减少上下文）",
							onClick: (e) => {
								e.stopPropagation();
								onCompact(agent.id);
							}
						}, h(Icon, { name: "minimize", size: 12 })),
						h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "清空会话历史",
							onClick: (e) => {
								e.stopPropagation();
								onNewSession(agent.id);
							}
						}, h(Icon, { name: "rotate-ccw", size: 12 })),
						h("button", {
							type: "button",
							className: "dhac_cardClose",
							title: "关闭智能体",
							onClick: (e) => {
								e.stopPropagation();
								onCloseAgent(agent.id);
							}
						}, h(Icon, { name: "x", size: 12 }))
					])
			]),
			agent.role !== "" && h("div", { className: "dhac_agentRole", title: agent.role }, agent.role),
			(agent.briefing === "pending" || agent.briefing === "failed") && h("div", {
				className: agent.briefing === "failed" ? "dhac_briefing dhac_briefingFailed" : "dhac_briefing",
				title: "角色/技能简报会在智能体启动就绪后自动写入并回车执行"
			}, [
				h(Icon, { name: agent.briefing === "pending" ? "clock" : "alert", size: 11, className: "dhac_inlineIcon" }),
				agent.briefing === "pending" ? "简报注入中（等待启动就绪后自动回车执行）…" : "简报未能确认执行，请打开终端检查"
			]),
			h("div", { className: "dhac_agentMeta", title: `${agent.cwd} · 会话 ${agent.sessionName ?? agent.sessionId ?? "-"}` },
				`#${agent.pid ?? "?"}${agent.sessionName ? ` · ${agent.sessionName}` : ""}${agent.workspaceId ? ` · ws:${agent.workspaceId}` : ""}${agent.external ? " · herdr" : ""}${agent.restored ? " · 已恢复" : ""}`),
			ghost
				? h("div", { className: "dhac_cardExited" }, [
					"未运行（恢复失败或已关闭）— ",
					h(Icon, { name: "power", size: 11, className: "dhac_inlineIcon" }),
					" 恢复 / ",
					h(Icon, { name: "x", size: 11, className: "dhac_inlineIcon" }),
					" 删除记录"
				])
				: (agent.exited
					? h("div", { className: "dhac_cardExited" }, `进程已退出 (code ${agent.exitCode ?? "?"}) — 点击重新创建`)
					: h(MiniTerminal, { agentId: agent.id }))
		]);
	}));
}

function TerminalDetail({ agent, onBack, onCompact, onNewSession, onCloseAgent, onRestore, onForget }) {
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const ghost = agent.running === false;
	const sendText = async () => {
		const text = draft.trim();
		if (text === "" || sending) return;
		setSending(true);
		try {
			await apiPost(`/agents/${encodeURIComponent(agent.id)}/send`, { text, submit: true });
			setDraft("");
		} catch {}
		setSending(false);
	};
	const signalInt = () => {
		apiPost(`/agents/${encodeURIComponent(agent.id)}/signal`, { signal: "SIGINT" }).catch(() => {});
	};
	return h("div", { className: "dhac_root" }, [
		h("div", { className: "dhac_toolbar" }, [
			h("button", { type: "button", className: "dhac_iconButton", title: "返回列表", onClick: onBack }, h(Icon, { name: "chevron-left", size: 14 })),
			h("span", { className: "dhac_toolbarName", title: `${agent.name} · ${agent.cwd}` }, `${agent.name} (${agent.type})`),
			h("span", { className: "dhac_agentMeta" }, ghost ? "已保存·未运行" : (STATUS_LABEL[agent.status] ?? agent.status)),
			ghost && h("button", { type: "button", className: "dhac_iconButton", title: "重新启动该智能体（恢复会话）", onClick: () => onRestore(agent.id) }, h(Icon, { name: "power", size: 13 })),
			ghost && h("button", { type: "button", className: "dhac_iconButton", title: "删除该保存记录（从 .deepseek/agents.json 移除）", onClick: () => { onForget(agent.id); onBack(); } }, h(Icon, { name: "x", size: 13 })),
			!ghost && COMPACT_SUPPORTED.has(agent.type) && h("button", { type: "button", className: "dhac_iconButton", title: "压缩会话（减少上下文）", onClick: () => onCompact(agent.id) }, h(Icon, { name: "minimize", size: 13 })),
			!ghost && h("button", { type: "button", className: "dhac_iconButton", title: "清空会话历史", onClick: () => onNewSession(agent.id) }, h(Icon, { name: "rotate-ccw", size: 13 })),
			!ghost && h("button", { type: "button", className: "dhac_iconButton", title: "中断 (Ctrl+C)", onClick: signalInt }, h(Icon, { name: "stop", size: 13 })),
			!ghost && h("button", { type: "button", className: "dhac_iconButton", title: "关闭智能体", onClick: () => { onCloseAgent(agent.id); onBack(); } }, h(Icon, { name: "x", size: 13 }))
		]),
		ghost
			? h("div", { className: "dhac_terminalDead" }, [
				h("div", null, "该智能体记录保存在本工作区的 .deepseek/agents.json 中，但进程未运行（恢复失败或已关闭）。"),
				h("div", { className: "dhac_terminalDeadHint" }, [
					"点「",
					h(Icon, { name: "power", size: 11, className: "dhac_inlineIcon" }),
					" 恢复」重新启动；点「",
					h(Icon, { name: "x", size: 11, className: "dhac_inlineIcon" }),
					"」删除该记录。"
				])
			])
			: (agent.exited
				? h("div", { className: "dhac_terminalDead" }, [`进程已退出 (code ${agent.exitCode ?? "?"})`])
				: h("div", { className: "dhac_termBody" }, [
					h(TailView, { agentId: agent.id }),
					h("div", { className: "dhac_sendBox" }, [
						h("input", {
							className: "dhac_input",
							value: draft,
							placeholder: "输入指令，回车发送（经 herdr 执行）…",
							onChange: (e) => setDraft(e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter") sendText(); }
						}),
						h("button", { type: "button", className: "dhac_btn dhac_btnPrimary", onClick: sendText, disabled: sending }, sending ? "发送中…" : "发送")
					])
				]))
	]);
}

// ---------------------------------------------------------------------------
// Safe panel: a render error boundary that shows the error IN the panel and
// does NOT rethrow — the slot renderer only abdicates on errors that escape
// the component, so keeping the error inside keeps us the details winner and
// makes any failure visible instead of silently falling back to the
// conversation details view.
// ---------------------------------------------------------------------------
var SafePanel = class extends react.Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}
	static getDerivedStateFromError(error) {
		return { error };
	}
	componentDidCatch(error) {
		console.error("[dsh-agent-commander] RadarPanel render error:", error);
	}
	render() {
		if (this.state.error !== null) {
			const error = this.state.error;
			return h("div", {
				style: {
					padding: "16px",
					fontSize: "12px",
					lineHeight: "1.6",
					color: "#f2a1a1",
					whiteSpace: "pre-wrap",
					overflow: "auto",
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
				}
			}, `[dsh-agent-commander] 面板渲染错误：\n${error instanceof Error ? error.message : String(error)}\n\n${error instanceof Error && error.stack ? error.stack : ""}`);
		}
		return this.props.children;
	}
};

// ---------------------------------------------------------------------------
// Radar panel — registered into the real "details" column slot
// ---------------------------------------------------------------------------
function RadarPanel(props) {
	const [agents, setAgentsState] = useState(getAgents);
	const [detailId, setDetailId] = useState(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [toasts, setToasts] = useState([]);
	const [workspaceCwd, setWorkspaceCwd] = useState(void 0);
	const [savedGhosts, setSavedGhosts] = useState([]);
	const [scanning, setScanning] = useState(false);
	const [herdrInfo, setHerdrInfo] = useState({ available: false, version: null });
	const [herdrSpace, setHerdrSpace] = useState(null);
	const { rootRef, onDragStart } = useDetailsColumn();
	const sessionId = props.sessionId;
	const sessionCwd = typeof props.useSessions === "function"
		? props.useSessions((s) => (s.current !== void 0 ? s.byId[s.current]?.cwd : void 0))
		: void 0;
	const sessionName = typeof props.useSessions === "function"
		? props.useSessions((s) => (s.current !== void 0 ? s.byId[s.current]?.title : void 0))
		: void 0;
	const workspaceId = typeof props.useWorkspaces === "function"
		? props.useWorkspaces((s) => (sessionId !== void 0 ? s.items?.find((w) => w.sessionIds?.includes(sessionId))?.workspaceId : void 0))
		: void 0;

	const pushToast = useCallback((text, kind) => {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		setToasts((list) => [...list.slice(-4), { id, text, kind }]);
		setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 6000);
	}, []);

	// 重新检测：向服务端扫描本文件夹 .deepseek/agents.json（恢复未运行的
	// 已保存智能体、返回“已保存未运行”的幽灵记录），并拉取本文件夹的智能体列表。
	const reDetect = useCallback((cwd) => {
		if (typeof cwd === "string" && cwd !== "") {
			setScanning(true);
			apiPost("/agents/scan", { cwd }).then((value) => {
				setAgents(value?.agents ?? []);
				setSavedGhosts(value?.saved ?? []);
				if (Number(value?.restored ?? 0) > 0) pushToast(`重新检测：已恢复 ${value.restored} 个本文件夹的智能体`, "done");
			}).catch(() => {
				apiGet(`/agents?cwd=${encodeURIComponent(cwd)}`).then((v) => setAgents(v?.agents ?? [])).catch(() => {});
			}).finally(() => setScanning(false));
		} else {
			setSavedGhosts([]);
			apiGet("/agents").then((v) => setAgents(v?.agents ?? [])).catch(() => {});
		}
	}, [pushToast]);

	// 每次切换工作区（会话工作目录变化）→ 重新检测本文件夹的智能体列表：
	// 1) 列表 WS 按 cwd 重新连接（后续只推送本文件夹的智能体）
	// 2) 扫描 .deepseek/agents.json 恢复/列出本文件夹的智能体
	useEffect(() => {
		const cwd = typeof sessionCwd === "string" && sessionCwd !== "" ? sessionCwd : void 0;
		setWorkspaceCwd(cwd);
		setListCwd(cwd);
		reDetect(cwd);
	}, [sessionCwd, reDetect]);

	// herdr 状态徽标（头部）：host 是 herdr 还是本地进程。
	useEffect(() => {
		apiGet("/herdr/status").then((value) => {
			setHerdrInfo({
				available: value?.available === true,
				version: value?.version ?? null,
				agentHost: value?.agentHost ?? "auto"
			});
		}).catch(() => {});
	}, []);

	// 当前工作区对应的 herdr 空间（不存在则显示“新建时自动创建”）。
	useEffect(() => {
		const cwd = typeof sessionCwd === "string" && sessionCwd !== "" ? sessionCwd : void 0;
		if (cwd === void 0) {
			setHerdrSpace(null);
			return;
		}
		let cancelled = false;
		apiGet(`/herdr/workspace?cwd=${encodeURIComponent(cwd)}`).then((value) => {
			if (!cancelled) setHerdrSpace(value?.workspace ?? null);
		}).catch(() => {});
		return () => { cancelled = true; };
	}, [sessionCwd]);

	// Status notifications: diff the pushed list and toast meaningful
	// transitions. The diff is reset whenever the workspace scope changes, so
	// switching folders never toasts false "已关闭/已创建" for other folders.
	const prevRef = useRef([]);
	const prevCwdRef = useRef(void 0);
	useEffect(() => {
		connectListWs();
		const unsub = subscribeAgents((next) => {
			const cwdNow = listCwd;
			const prev = prevCwdRef.current === cwdNow ? prevRef.current : [];
			prevCwdRef.current = cwdNow;
			prevRef.current = next;
			if (prev.length > 0) {
				const byId = new Map(prev.map((a) => [a.id, a]));
				for (const agent of next) {
					const old = byId.get(agent.id);
					if (old === void 0) {
						pushToast(`智能体 ${agent.name}（${agent.type}）已创建`, "create");
					} else if (old.status === "working" && agent.status === "idle") {
						pushToast(`智能体 ${agent.name} 已完成任务，回到空闲`, "done");
					} else if (old.status !== "exited" && agent.status === "exited") {
						pushToast(`智能体 ${agent.name} 已退出`, "exit");
					}
				}
				for (const agent of prev) {
					if (!next.some((a) => a.id === agent.id)) pushToast(`智能体 ${agent.name} 已关闭`, "exit");
				}
			}
			setAgentsState(next);
		});
		return unsub;
	}, [pushToast]);

	const merged = savedGhosts.length > 0 ? [...agents, ...savedGhosts] : agents;
	const detail = detailId === null ? void 0 : merged.find((a) => a.id === detailId);
	const closeAgent = async (id) => {
		try {
			// graceful: ask the agent to /exit itself before the server escalates
			await apiDelete(`/agents/${encodeURIComponent(id)}?graceful=1`);
		} catch {}
	};
	const newSession = async (id) => {
		try {
			await apiPost(`/agents/${encodeURIComponent(id)}/new-session`, {});
		} catch {}
	};
	const compactSession = async (id) => {
		try {
			await apiPost(`/agents/${encodeURIComponent(id)}/compact`, {});
		} catch {}
	};
	const restoreSaved = async (id) => {
		try {
			const value = await apiPost(`/agents/${encodeURIComponent(id)}/restore`, { cwd: workspaceCwd, sessionId });
			if (value?.agent) pushToast(`智能体 ${value.agent.name}（${value.agent.type}）已恢复`, "done");
		} catch (err) {
			pushToast(`恢复失败：${err instanceof Error ? err.message : String(err)}`, "exit");
		}
		reDetect(workspaceCwd);
	};
	const forgetSaved = async (id) => {
		try {
			const value = await apiPost(`/agents/${encodeURIComponent(id)}/forget`, { cwd: workspaceCwd, sessionId });
			if (value?.removed) pushToast("已删除该智能体的保存记录", "done");
			else pushToast("没有找到该保存记录", "exit");
		} catch (err) {
			pushToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, "exit");
		}
		reDetect(workspaceCwd);
	};
	const workspaceLabel = workspaceCwd !== void 0
		? (workspaceCwd.split("/").filter(Boolean).pop() || workspaceCwd)
		: "全部工作区";

	return h("div", { ref: rootRef, className: "dhac_root" }, [
		h("div", { className: "dhac_resizeHandle", title: "拖拽调整宽度", onPointerDown: onDragStart }),
		h("div", { className: "dhac_header" }, [
			h("span", { className: "dhac_headerTitle" }, "智能体雷达"),
			h("span", {
				className: herdrInfo.available ? "dhac_hostBadge dhac_hostBadgeOn" : "dhac_hostBadge",
				title: herdrInfo.available
					? `智能体宿主：herdr v${herdrInfo.version ?? "?"}（后台 server 持有进程）`
					: "智能体宿主：DSH 本地进程（未检测到 herdr）"
			}, herdrInfo.available ? `herdr v${herdrInfo.version ?? "?"}` : "本地进程"),
			h("span", { className: "dhac_count" }, String(merged.length)),
			h("button", { type: "button", className: "dhac_iconButton", title: "重新检测本文件夹的智能体列表", onClick: () => reDetect(workspaceCwd), disabled: scanning },
				h(Icon, { name: "refresh-cw", size: 13, className: scanning ? "dhac_spin" : "" })),
			h("button", { type: "button", className: "dhac_addButton", onClick: () => setDialogOpen(true) }, [
				h(Icon, { name: "plus", size: 13 }),
				h("span", null, "新建")
			])
		]),
		h("div", { className: "dhac_workspace", title: workspaceCwd ?? "未绑定工作区（显示全部智能体）" }, [
			h(Icon, { name: "folder", size: 12, className: "dhac_inlineIcon" }),
			h("span", null, `${workspaceLabel}${scanning ? " · 检测中…" : ""}`),
			herdrSpace !== null && h("span", { className: "dhac_herdrSpaceTag", title: `herdr 空间 ${herdrSpace.workspaceId}（${herdrSpace.label}，${herdrSpace.paneCount} 面板）` }, [
				h(Icon, { name: "layout", size: 11, className: "dhac_inlineIcon" }),
				`空间 ${herdrSpace.workspaceId}`
			])
		]),
		h("div", { className: "dhac_toasts" },
			toasts.map((t) =>
				h("div", { key: t.id, className: `dhac_toast dhac_toast_${t.kind}` }, t.text))),
		h("div", { className: "dhac_body" },
			detail !== void 0
				? h(TerminalDetail, { agent: detail, onBack: () => setDetailId(null), onCompact: compactSession, onNewSession: newSession, onCloseAgent: closeAgent, onRestore: restoreSaved, onForget: forgetSaved })
				: h(AgentCards, { agents: merged, scoped: workspaceCwd !== void 0, onOpen: (agent) => setDetailId(agent.id), onCompact: compactSession, onNewSession: newSession, onCloseAgent: closeAgent, onRestore: restoreSaved, onForget: forgetSaved })),
		dialogOpen &&
			h(NewAgentDialog, {
				sessionId,
				sessionName,
				workspaceId,
				defaultCwd: sessionCwd,
				onClose: () => setDialogOpen(false),
				onCreated: () => reDetect(workspaceCwd)
			})
	]);
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------
const inject = ["slots", "layout", "sessions"];

function fail(phase, error) {
	console.error(`[dsh-agent-commander] ${phase} error:`, error);
	try {
		const bar = document.createElement("div");
		bar.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f2a1a1;background:#1b1b22;border:1px solid #f2a1a1;border-radius:8px;white-space:pre-wrap";
		bar.textContent = `[dsh-agent-commander] ${phase} error: ${error instanceof Error ? error.message : String(error)}`;
		document.body.appendChild(bar);
	} catch {}
}

function apply(ctx) {
	try {
		// Standard programmatic API: window.dshAgentCommander — exposed for other
		// plugins / user scripts. Methods: list/open/send/read/approve/signal/
		// close/status + memory.list/search/add + onStatus(listener).
		ctx.effect(() => {
			const api = {
				list: (cwd) => apiGet(typeof cwd === "string" && cwd !== "" ? `/agents?cwd=${encodeURIComponent(cwd)}` : "/agents").then((v) => v?.agents ?? []),
				scan: (cwd) => apiPost("/agents/scan", { cwd }).then((v) => v?.agents ?? []),
				open: (opts) => apiPost("/agents", opts).then((v) => v?.agent),
				send: (id, text, submit) => apiPost(`/agents/${encodeURIComponent(id)}/send`, { text, submit: submit === true }),
				read: (id, bytes) => apiGet(`/agents/${encodeURIComponent(id)}/read?bytes=${Number.isFinite(bytes) ? bytes : 12000}`),
				approve: (id, choice) => apiPost(`/agents/${encodeURIComponent(id)}/approve`, { choice }),
				signal: (id, signal) => apiPost(`/agents/${encodeURIComponent(id)}/signal`, { signal }),
				close: (id, graceful) => apiDelete(`/agents/${encodeURIComponent(id)}?graceful=${graceful === false ? "0" : "1"}`),
				status: (id) => apiGet(`/agents/${encodeURIComponent(id)}/status`),
				newSession: (id) => apiPost(`/agents/${encodeURIComponent(id)}/new-session`, {}),
				compactSession: (id) => apiPost(`/agents/${encodeURIComponent(id)}/compact`, {}),
				restore: (id, cwd) => apiPost(`/agents/${encodeURIComponent(id)}/restore`, { cwd }).then((v) => v?.agent),
				forget: (id, cwd) => apiPost(`/agents/${encodeURIComponent(id)}/forget`, { cwd }).then((v) => v?.removed === true),
				memory: {
					list: (ns) => apiGet(`/memory${ns ? `?namespace=${encodeURIComponent(ns)}` : ""}`).then((v) => v?.entries ?? []),
					search: (q) => apiGet(`/memory/search?q=${encodeURIComponent(q)}`).then((v) => v?.entries ?? []),
					add: (entry) => apiPost("/memory", entry)
				},
				onStatus: (fn) => {
					agentListeners.add(fn);
					return () => agentListeners.delete(fn);
				}
			};
			try {
				globalThis.__dshAgentCommander__ = api;
				window.dshAgentCommander = api;
			} catch {}
			return () => {
				try {
					if (window.dshAgentCommander === api) delete window.dshAgentCommander;
				} catch {}
			};
		}, "dsh-agent-commander: global api");
		ctx.effect(() => {
			// Global safety net: keep the details column track open even if the
			// panel itself ever crashes — decoupled from RadarPanel's lifecycle.
			const enforce = () => {
				// Reset the rAF guard first — without this the observer is
				// one-shot: after the first mutation raf stays truthy and every
				// later schedule() no-ops, so switching to a new (blank) session
				// zeroes the details track and the sidebar never comes back.
				raf = 0;
				try {
					if (isPanelCollapsed()) return;
					const outlet = document.querySelector('[data-slot="details"]');
					const column = outlet?.parentElement;
					const frame = column?.parentElement;
					if (frame === null || frame === void 0) return;
					const style = frame.style.gridTemplateColumns;
					if (typeof style !== "string" || style === "") return;
					const last = style.match(/(\S+)\s*$/)?.[1];
					if (last === "0px" || last === "0") {
						const w = Number(localStorage.getItem(PANEL_WIDTH_KEY));
						const width = Number.isFinite(w) && w >= 280 && w <= 620 ? w : PANEL_WIDTH_DEFAULT;
						frame.style.gridTemplateColumns = style.replace(/(\S+)\s*$/, `${width}px`);
						frame.removeAttribute("data-details-collapsed");
					}
				} catch {}
			};
			let raf = 0;
			const schedule = () => {
				if (raf === 0) raf = requestAnimationFrame(enforce);
			};
			const observer = new MutationObserver(schedule);
			observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style", "data-details-collapsed"] });
			schedule();
			return () => {
				observer.disconnect();
				if (raf !== 0) cancelAnimationFrame(raf);
			};
		}, "dsh-agent-commander: global column enforcement");
		// Helper: find the AppFrame grid element and enforce details column width.
		function enforceDetailsWidth(forceOpen) {
			try {
				// Try multiple selectors to find the grid frame.
				const outlet = document.querySelector('[data-slot="details"]')
					|| document.querySelector('.detailsCol')
					|| document.querySelector('[class*="details"]');
				const column = outlet?.parentElement;
				const frame = column?.parentElement;
				if (!frame) return;
				const style = frame.style.gridTemplateColumns;
				if (typeof style !== "string" || style === "") return;
				const last = style.match(/(\S+)\s*$/)?.[1];
				if (forceOpen) {
					if (last === "0px" || last === "0") {
						const w = Number(localStorage.getItem(PANEL_WIDTH_KEY));
						const width = Number.isFinite(w) && w >= 280 && w <= 620 ? w : PANEL_WIDTH_DEFAULT;
						frame.style.gridTemplateColumns = style.replace(/(\S+)\s*$/, `${width}px`);
						frame.removeAttribute("data-details-collapsed");
					}
				} else {
					if (last !== "0px" && last !== "0") {
						frame.style.gridTemplateColumns = style.replace(/(\S+)\s*$/, "0px");
						frame.setAttribute("data-details-collapsed", "");
					}
				}
			} catch {}
		}
		// Periodic enforcement: keeps sidebar open unless user collapsed it.
		ctx.effect(() => {
			const timer = setInterval(() => {
				if (!isPanelCollapsed()) enforceDetailsWidth(true);
			}, 800);
			return () => clearInterval(timer);
		}, "dsh-agent-commander: periodic enforcement");
		// Floating toggle button on the main interface: always visible, clicks
		// pop the Agent Radar sidebar in / out. It auto-positions just LEFT of
		// the details column when the panel is open (so it never covers the
		// radar's own header), otherwise at the window's right edge.
		ctx.effect(() => {
			const cluster = document.createElement("div");
			cluster.className = "dhac_toggleCluster";
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "dhac_toggleButton";
			btn.title = "智能体雷达（点击弹出/收起侧边栏）";
			const icon = document.createElement("span");
			icon.className = "dhac_toggleIcon";
			icon.innerHTML = iconSvgMarkup("bot", 15);
			const label = document.createElement("span");
			label.className = "dhac_toggleLabel";
			label.textContent = "雷达";
			btn.appendChild(icon);
			btn.appendChild(label);
			btn.addEventListener("click", () => {
				const collapsed = isPanelCollapsed();
				if (collapsed) {
					// Pop the sidebar open.
					setPanelCollapsed(false);
					enforceDetailsWidth(true);
					try { ctx.layout.openDetails(); } catch {}
				} else {
					// Collapse it again.
					setPanelCollapsed(true);
					enforceDetailsWidth(false);
					try { ctx.layout.closeDetails(); } catch {}
				}
				sync();
			});
			cluster.appendChild(btn);
			document.body.appendChild(cluster);
			// Read the frame's current details track width (0 = closed).
			const detailsWidth = () => {
				try {
					const outlet = document.querySelector('[data-slot="details"]');
					const frame = outlet?.parentElement?.parentElement;
					if (!frame) return 0;
					const style = frame.style.gridTemplateColumns;
					if (typeof style !== "string" || style === "") return 0;
					const last = style.match(/(\S+)\s*$/)?.[1];
					if (last === void 0 || last === "0px" || last === "0") return 0;
					const n = Number.parseFloat(last);
					return Number.isFinite(n) && n > 0 ? n : 0;
				} catch {
					return 0;
				}
			};
			// Keep the button next to the details column edge (never on top of it).
			const sync = () => {
				try {
					const w = detailsWidth();
					const open = !isPanelCollapsed() && w > 0;
					cluster.style.right = `${w > 0 ? w + 10 : 12}px`;
					cluster.classList.toggle("dhac_toggleCluster_open", open);
				} catch {}
			};
			sync();
			const syncTimer = setInterval(sync, 600);
			let raf = 0;
			const scheduleSync = () => {
				if (raf === 0) raf = requestAnimationFrame(() => {
					raf = 0;
					sync();
				});
			};
			const observer = new MutationObserver(scheduleSync);
			observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style", "data-details-collapsed"] });
			return () => {
				clearInterval(syncTimer);
				observer.disconnect();
				if (raf !== 0) cancelAnimationFrame(raf);
				cluster.remove();
			};
		}, "dsh-agent-commander: toggle button");
		ctx.effect(() => {
			// Register the RadarPanel into the details slot and try to open it.
			if (!isPanelCollapsed()) {
				try { ctx.layout.openDetails(); } catch {}
			}
			let disposeRegistration = () => {};
			try {
				disposeRegistration = ctx.slots.register({
					name: "details",
					priority: -100
				}, RadarPanelSafe);
				console.info("[dsh-agent-commander] registered into details slot");
			} catch (error) {
				fail("register", error);
			}
			return () => {
				disposeRegistration();
			};
		}, "dsh-agent-commander: details registration");
	} catch (error) {
		fail("load", error);
	}
}

const RadarPanelSafe = (props) => h(SafePanel, null, h(RadarPanel, props));


		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
