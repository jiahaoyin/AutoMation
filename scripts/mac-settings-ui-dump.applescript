-- 诊断：打印 System Settings 登录页 AX 树（调试填表失败时用）
-- v1.0.24：所有 UI 属性必须在 tell process 内联读取，禁止把 entire contents 元素传给 handler
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

on mergeDescParts(parts)
	set merged to ""
	repeat with p in parts
		if p is not "" then
			if merged is "" then
				set merged to p
			else
				set merged to merged & " | " & p
			end if
		end if
	end repeat
	return merged
end mergeDescParts

tell application "System Settings" to activate
delay 1.5

tell application "System Events"
	tell process "System Settings"
		set report to ""

		-- automation preflight (inline)
		try
			set frontmost to true
			delay 0.25
			set _wc to count of windows
			set report to report & "windows=" & _wc & linefeed
		on error errMsg number errNum
			return "AUTOMATION_DENIED:" & errNum & " " & errMsg & linefeed & "→ 请在 系统设置 → 隐私与安全性 → 自动化 中勾选 Terminal/Cursor 控制「系统设置」"
		end try

		if (count of windows) is 0 then
			return report & "no windows"
		end if

		-- find login window (inline)
		set targetW to missing value
		set markers to my loginPageMarkers()
		repeat with w in windows
			repeat with marker in markers
				set found to false
				try
					if name of w contains marker then set found to true
				end try
				if not found then
					try
						repeat with e in entire contents of w
							try
								if value of e contains marker then
									set found to true
									exit repeat
								end if
							end try
						end repeat
					end try
				end if
				if found then
					set targetW to w
					exit repeat
				end if
			end repeat
			if targetW is not missing value then exit repeat
		end repeat
		if targetW is missing value then set targetW to window 1

		try
			set _cls to class of targetW as text
			set report to report & "window1.class=" & _cls & linefeed
			if _cls is "" then
				set report to report & "WARNING: class empty — Accessibility 可能已开，但 Automation 未授予 Terminal→系统设置" & linefeed
			end if
		on error errMsg number errNum
			return report & "READ_DENIED:" & errNum & " " & errMsg & linefeed & "→ 打开 隐私与安全性 → 自动化，勾选控制「系统设置」"
		end try
		try
			set report to report & "window1.name=" & (name of targetW) & linefeed
		on error errMsg number errNum
			set report to report & "window1.name ERR:" & errNum & linefeed
		end try

		set report to report & "login window found" & linefeed

		set nAll to 0
		set nDeep to 0
		set nShallow to 0

		try
			repeat with e in entire contents of targetW
				set nAll to nAll + 1

				set cls to ""
				set roleDesc to ""
				set subroleDesc to ""
				set descParts to {}

				try
					set cls to class of e as text
				on error errMsg number errNum
					set cls to "ERR:" & errNum & ":" & errMsg
				end try
				try
					set roleDesc to value of attribute "AXRoleDescription" of e
				on error errMsg number errNum
					set roleDesc to "ERR:" & errNum
				end try
				try
					set subroleDesc to value of attribute "AXSubrole" of e
				on error errMsg number errNum
					set subroleDesc to "ERR:" & errNum
				end try

				repeat with propName in {"description", "title", "name", "value"}
					try
						if propName is "description" then
							set t to my safeText(description of e)
						else if propName is "title" then
							set t to my safeText(title of e)
						else if propName is "name" then
							set t to my safeText(name of e)
						else
							set t to my safeText(value of e)
						end if
						if t is not "" then set end of descParts to t
					end try
				end repeat
				try
					set t to my safeText(value of attribute "AXPlaceholderValue" of e)
					if t is not "" then set end of descParts to t
				end try

				set desc to my mergeDescParts(descParts)

				if nAll is less than or equal to 30 then
					set report to report & "#" & nAll & " class=" & cls & " role=" & roleDesc & " subrole=" & subroleDesc & " desc=" & desc & linefeed
				end if

				if cls is in {"text field", "text area", "combo box"} then
					set nDeep to nDeep + 1
					if nDeep is less than or equal to 10 then
						set report to report & "  [input deep#" & nDeep & "] " & desc & linefeed
					end if
				end if
			end repeat
		on error errMsg number errNum
			set report to report & "iterate ERR:" & errNum & " " & errMsg & linefeed
		end try

		try
			repeat with tf in every text field of targetW
				set nShallow to nShallow + 1
				set shallowDesc to ""
				try
					set shallowDesc to description of tf
				end try
				if shallowDesc is "" then
					try
						set shallowDesc to name of tf
					end try
				end if
				set report to report & "shallow#" & nShallow & ": " & shallowDesc & linefeed
			end repeat
		on error errMsg number errNum
			set report to report & "shallow ERR:" & errNum & " " & errMsg & linefeed
		end try

		set report to report & "elements=" & nAll & " deep=" & nDeep & " shallow=" & nShallow
		return report
	end tell
end tell
