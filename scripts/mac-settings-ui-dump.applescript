-- 诊断：打印 System Settings 登录页 AX 树（调试填表失败时用）
-- v1.0.25：禁止 entire contents（含 repeat with e in entire contents，macOS 会隐式 item i 索引导致 -1700）
-- 改用 BFS + UI element ci of parent 逐层遍历
-- 用法: osascript scripts/mac-settings-ui-dump.applescript

tell application "System Settings" to activate
delay 1

tell application "System Events"
	tell process "System Settings"
		set report to ""

		try
			set frontmost to true
			delay 0.25
			set report to report & "windows=" & (count of windows) & linefeed
		on error errMsg number errNum
			return "AUTOMATION_DENIED:" & errNum & " " & errMsg & linefeed & "→ 请在 系统设置 → 隐私与安全性 → 自动化 中勾选 Terminal/Cursor 控制「系统设置」"
		end try

		if (count of windows) is 0 then
			return report & "no windows"
		end if

		set targetW to window 1
		set winCount to count of windows
		set markers to {"一个账户", "电子邮件或电话号码", "Email or phone", "登录"}
		repeat with wi from 1 to winCount
			set matched to false
			try
				set wName to name of window wi
				repeat with marker in markers
					if wName contains marker then
						set matched to true
						exit repeat
					end if
				end repeat
			end try
			if matched then
				set targetW to window wi
				exit repeat
			end if
		end repeat

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

		set n to 0
		set nDeep to 0
		set nShallow to 0
		set queue to {targetW}

		repeat 200 times
			if (count of queue) is 0 then exit repeat
			set parentRef to item 1 of queue
			set queue to rest of queue
			try
				set childCount to count of UI elements of parentRef
				repeat with ci from 1 to childCount
					set childEl to UI element ci of parentRef
					set n to n + 1
					set c to ""
					set roleDesc to ""
					set desc to ""
					try
						set c to class of childEl as text
					on error errMsg number errNum
						set c to "ERR:" & errNum
					end try
					try
						set roleDesc to value of attribute "AXRoleDescription" of childEl
					end try
					try
						set desc to description of childEl
					end try
					if desc is "" then
						try
							set desc to name of childEl
						end try
					end if
					if n is less than or equal to 30 then
						set report to report & "#" & n & " class=" & c & " role=" & roleDesc & " desc=" & desc & linefeed
					end if
					if c is in {"text field", "text area", "combo box"} then
						set nDeep to nDeep + 1
						if nDeep is less than or equal to 10 then
							set report to report & "  [input deep#" & nDeep & "] " & desc & linefeed
						end if
					end if
					if c is in {"group", "scroll area", "split group", "tab group", "splitter group"} then
						set end of queue to childEl
					end if
					if n >= 30 and (count of queue) is 0 then exit repeat
				end repeat
			end try
			if n >= 30 and (count of queue) is 0 then exit repeat
		end repeat

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
			set report to report & "shallow ERR:" & errNum & linefeed
		end try

		return report & "elements=" & n & " deep=" & nDeep & " shallow=" & nShallow
	end tell
end tell
