-- 诊断：打印 System Settings 登录页 AX 树（调试填表失败时用）
-- 用法: osascript scripts/mac-settings-ui-dump.applescript

on loginPageMarkers()
	return {"一个账户", "电子邮件或电话号码", "Email or phone", "登录"}
end loginPageMarkers

on safeText(v)
	if v is missing value then return ""
	try
		return v as text
	on error
		return ""
	end try
end safeText

on readProp(procRef, e, propName)
	tell application "System Events"
		tell procRef
			try
				if propName is "class" then return class of e as text
				if propName is "description" then return description of e
				if propName is "title" then return title of e
				if propName is "name" then return name of e
				if propName is "value" then return value of e
				if propName is "AXRoleDescription" then return value of attribute "AXRoleDescription" of e
				if propName is "AXSubrole" then return value of attribute "AXSubrole" of e
				if propName is "AXPlaceholderValue" then return value of attribute "AXPlaceholderValue" of e
			on error errMsg number errNum
				return "ERR:" & errNum & ":" & errMsg
			end try
		end tell
	end tell
	return ""
end readProp

on windowMatchesMarker(procRef, w, marker)
	tell application "System Events"
		tell procRef
			try
				if name of w contains marker then return true
			end try
			try
				repeat with e in entire contents of w
					try
						if value of e contains marker then return true
					end try
				end repeat
			end try
		end tell
	end tell
	return false
end windowMatchesMarker

on findLoginWindow(procRef)
	tell application "System Events"
		tell procRef
			repeat with w in windows
				repeat with marker in my loginPageMarkers()
					if my windowMatchesMarker(procRef, w, marker) then return w
				end repeat
			end repeat
			if (count of windows) > 0 then return window 1
		end tell
	end tell
	return missing value
end findLoginWindow

on elementDescription(procRef, e)
	set parts to {}
	set propNames to {"description", "title", "name", "AXRoleDescription", "AXPlaceholderValue", "value"}
	repeat with p in propNames
		set t to my safeText(my readProp(procRef, e, p))
		if t is not "" and t does not start with "ERR:" then
			if (count of parts) is 0 then
				set parts to {t}
			else
				set end of parts to t
			end if
		end if
	end repeat
	set merged to ""
	repeat with p in parts
		if merged is "" then
			set merged to p
		else
			set merged to merged & " | " & p
		end if
	end repeat
	return merged
end elementDescription

on elementSummary(procRef, e, idx)
	set cls to my readProp(procRef, e, "class")
	set roleDesc to my readProp(procRef, e, "AXRoleDescription")
	set subroleDesc to my readProp(procRef, e, "AXSubrole")
	set desc to my elementDescription(procRef, e)
	return "#" & idx & " class=" & cls & " role=" & roleDesc & " subrole=" & subroleDesc & " desc=" & desc
end elementSummary

on automationPreflight(procRef)
	set report to ""
	tell application "System Settings" to activate
	delay 0.6
	tell application "System Events"
		tell procRef
			set frontmost to true
			delay 0.25
			try
				set _wc to count of windows
				set report to report & "windows=" & _wc & linefeed
			on error errMsg number errNum
				return "AUTOMATION_DENIED:" & errNum & " " & errMsg & linefeed & "→ 请在 系统设置 → 隐私与安全性 → 自动化 中勾选 Terminal/Cursor 控制「系统设置」"
			end try
			if (count of windows) is 0 then
				return report & "no windows" & linefeed
			end if
			set w to window 1
			try
				set _cls to class of w as text
				set report to report & "window1.class=" & _cls & linefeed
				if _cls is "" then
					set report to report & "WARNING: class empty — Accessibility 可能已开，但 Automation 未授予 Terminal→系统设置" & linefeed
				end if
			on error errMsg number errNum
				return report & "READ_DENIED:" & errNum & " " & errMsg & linefeed & "→ 打开 隐私与安全性 → 自动化，勾选控制「系统设置」"
			end try
			try
				set _n to name of w
				set report to report & "window1.name=" & _n & linefeed
			on error errMsg number errNum
				set report to report & "window1.name ERR:" & errNum & linefeed
			end try
		end tell
	end tell
	return report
end automationPreflight

tell application "System Settings" to activate
delay 1.5

tell application "System Events"
	tell process "System Settings"
		set procRef to it
		set report to my automationPreflight(procRef)
		set targetW to my findLoginWindow(procRef)
		if targetW is missing value then
			return report & "no login window"
		end if

		set nDeep to 0
		set nShallow to 0
		set nAll to 0
		set report to report & "login window found" & linefeed

		try
			repeat with e in entire contents of targetW
				set nAll to nAll + 1
				if nAll is less than or equal to 30 then
					set report to report & my elementSummary(procRef, e, nAll) & linefeed
				end if
				set cls to my readProp(procRef, e, "class")
				if cls is in {"text field", "text area", "combo box"} then
					set nDeep to nDeep + 1
					if nDeep is less than or equal to 10 then
						set report to report & "  [input deep#" & nDeep & "] " & my elementDescription(procRef, e) & linefeed
					end if
				end if
			end repeat
		on error errMsg number errNum
			set report to report & "iterate ERR:" & errNum & " " & errMsg & linefeed
		end try

		try
			repeat with tf in every text field of targetW
				set nShallow to nShallow + 1
				set report to report & "shallow#" & nShallow & ": " & my elementDescription(procRef, tf) & linefeed
			end repeat
		on error errMsg number errNum
			set report to report & "shallow ERR:" & errNum & " " & errMsg & linefeed
		end try

		set report to report & "elements=" & nAll & " deep=" & nDeep & " shallow=" & nShallow
		return report
	end tell
end tell
