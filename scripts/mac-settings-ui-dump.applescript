-- 诊断：打印 System Settings 登录页 AX 树（调试填表失败时用）
-- 用法: osascript scripts/mac-settings-ui-dump.applescript

on loginPageMarkers()
	return {"一个账户", "电子邮件或电话号码", "Email or phone", "登录"}
end loginPageMarkers

on windowMatchesMarker(w, marker)
	tell application "System Events"
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
	return false
end windowMatchesMarker

on findLoginWindow(procRef)
	tell application "System Events"
		tell procRef
			repeat with w in windows
				repeat with marker in my loginPageMarkers()
					if my windowMatchesMarker(w, marker) then return w
				end repeat
			end repeat
			if (count of windows) > 0 then return window 1
		end tell
	end tell
	return missing value
end findLoginWindow

on safeText(v)
	if v is missing value then return ""
	try
		return v as text
	on error
		return ""
	end try
end safeText

on elementDescription(e)
	tell application "System Events"
		set parts to {}
		try
			set end of parts to description of e
		end try
		try
			set end of parts to title of e
		end try
		try
			set end of parts to name of e
		end try
		try
			set end of parts to value of attribute "AXRoleDescription" of e
		end try
		try
			set end of parts to value of attribute "AXPlaceholderValue" of e
		end try
		try
			set end of parts to value of e
		end try
	end tell
	set merged to ""
	repeat with p in parts
		set t to my safeText(p)
		if t is not "" then
			if merged is "" then
				set merged to t
			else
				set merged to merged & " | " & t
			end if
		end if
	end repeat
	return merged
end elementDescription

on elementSummary(e, idx)
	set cls to ""
	set roleDesc to ""
	set subroleDesc to ""
	tell application "System Events"
		try
			set cls to class of e as text
		end try
		try
			set roleDesc to my safeText(value of attribute "AXRoleDescription" of e)
		end try
		try
			set subroleDesc to my safeText(value of attribute "AXSubrole" of e)
		end try
	end tell
	set desc to my elementDescription(e)
	return "#" & idx & " class=" & cls & " role=" & roleDesc & " subrole=" & subroleDesc & " desc=" & desc
end elementSummary

tell application "System Settings" to activate
delay 1.5

tell application "System Events"
	tell process "System Settings"
		set targetW to my findLoginWindow(it)
		if targetW is missing value then
			return "no login window"
		end if

		set nDeep to 0
		set nShallow to 0
		set nAll to 0
		set report to "login window found" & linefeed

		try
			repeat with e in entire contents of targetW
				set nAll to nAll + 1
				if nAll is less than or equal to 30 then
					set report to report & my elementSummary(e, nAll) & linefeed
				end if
				try
					if class of e as text is in {"text field", "text area", "combo box"} then
						set nDeep to nDeep + 1
						if nDeep is less than or equal to 10 then
							set report to report & "  [input deep#" & nDeep & "] " & my elementDescription(e) & linefeed
						end if
					end if
				end try
			end repeat
		end try

		try
			repeat with tf in every text field of targetW
				set nShallow to nShallow + 1
				set report to report & "shallow#" & nShallow & ": " & my elementDescription(tf) & linefeed
			end repeat
		end try

		set report to report & "elements=" & nAll & " deep=" & nDeep & " shallow=" & nShallow
		return report
	end tell
end tell
