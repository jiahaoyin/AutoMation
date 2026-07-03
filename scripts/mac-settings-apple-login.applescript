-- macOS 15 (Sequoia)：系统设置 → Apple Account 登录
-- v1.0.27：索引式 BFS（不缓存 AX 元素引用）；stderr 逐步日志；两阶段填表
-- 凭证：APPLE_SCRIPT_APPLE_ID、APPLE_SCRIPT_PASSWORD

on logStep(n, msg)
	do shell script "echo " & quoted form of ("[step " & n & "] " & msg) & " 1>&2"
end logStep

on openAppleAccountPane()
	set urls to {"x-apple.systempreferences:com.apple.systempreferences.AppleIDSettings", "x-apple.systempreferences:com.apple.preferences.AppleIDPref", "x-apple.systempreferences:com.apple.AccountSettings.AccountsSettingsExtension"}
	repeat with u in urls
		try
			do shell script "open " & quoted form of u
			return true
		end try
	end repeat
	return false
end openAppleAccountPane

on readCredentials()
	set appleId to system attribute "APPLE_SCRIPT_APPLE_ID"
	set applePassword to system attribute "APPLE_SCRIPT_PASSWORD"
	if appleId is missing value or appleId is "" then error "缺少 APPLE_SCRIPT_APPLE_ID"
	if applePassword is missing value or applePassword is "" then error "缺少 APPLE_SCRIPT_PASSWORD"
	return {appleId, applePassword}
end readCredentials

-- 在 parent 下按 BFS 找第 nth 个非搜索文本框（1-based）
-- 返回 {found, pathString}，pathString 如 "2/1/3"
using terms from application "System Events"
on bfsNthTextField(parentRef, wantIndex, maxDepth)
	set tfQueueEls to {parentRef}
	set tfQueuePaths to {""}
	set tfQueueDepths to {0}
	set tfCount to 0
	set queueIndex to 1
	repeat 250 times
		if queueIndex > (count of tfQueueEls) then exit repeat
		set curEl to item queueIndex of tfQueueEls
		set curPath to item queueIndex of tfQueuePaths
		set curDepth to item queueIndex of tfQueueDepths
		set queueIndex to queueIndex + 1
		try
			set childCount to count of UI elements of curEl
			repeat with ci from 1 to childCount
				set childEl to UI element ci of curEl
				set c to ""
				set roleDesc to ""
				set elDesc to ""
				try
					set c to class of childEl as text
				end try
				try
					set roleDesc to value of attribute "AXRoleDescription" of childEl
				end try
				try
					set elDesc to description of childEl
				end try
				if elDesc is "" then
					try
						set elDesc to name of childEl
					end try
				end if
				set childPath to curPath
				if childPath is "" then
					set childPath to (ci as text)
				else
					set childPath to curPath & "/" & (ci as text)
				end if
				if c is in {"text field", "text area", "combo box"} then
					set isSearch to false
					if roleDesc contains "搜索" then set isSearch to true
					if elDesc contains "搜索" then set isSearch to true
					if not isSearch then
						set tfCount to tfCount + 1
						if tfCount is wantIndex then
							return {true, childPath}
						end if
					end if
				end if
				if c is in {"group", "scroll area", "split group", "tab group", "splitter group"} then
					if curDepth < maxDepth then
						set end of tfQueueEls to childEl
						set end of tfQueuePaths to childPath
						set end of tfQueueDepths to (curDepth + 1)
					end if
				end if
			end repeat
		end try
	end repeat
	return {false, ""}
end bfsNthTextField

on resolvePath(rootRef, pathString)
	if pathString is "" then return rootRef
	set el to rootRef
	set AppleScript's text item delimiters to "/"
	set idxList to text items of pathString
	set AppleScript's text item delimiters to ""
	repeat with idxStr in idxList
		set idxNum to idxStr as integer
		set el to UI element idxNum of el
	end repeat
	return el
end resolvePath

on fillFieldAtPath(rootRef, pathString, textValue)
	set fieldEl to my resolvePath(rootRef, pathString)
	set the clipboard to textValue
	try
		click fieldEl
	on error
		try
			perform action "AXRaise" of fieldEl
		end try
	end try
	delay 0.35
	try
		set focused of fieldEl to true
	end try
	delay 0.12
	try
		set value of fieldEl to textValue
	end try
	delay 0.2
	keystroke "a" using command down
	delay 0.08
	keystroke "v" using command down
	delay 0.45
	set fieldVal to ""
	try
		set fieldVal to value of fieldEl as text
	end try
	return fieldVal
end fillFieldAtPath

on clickButtonNamed(targetW, btnNames)
	repeat with btnName in btnNames
		try
			set b to button btnName of targetW
			if enabled of b then
				click b
				return true
			end if
		end try
		try
			set b to first button of targetW whose name is btnName
			if enabled of b then
				click b
				return true
			end if
		end try
	end repeat
	return false
end clickButtonNamed
end using terms from

on run argv
	set creds to my readCredentials()
	set appleId to item 1 of creds
	set applePassword to item 2 of creds

	my logStep(1, "activating System Settings")
	tell application "System Settings" to activate
	delay 0.8

	set paneOpened to system attribute "APPLE_SCRIPT_PANE_OPENED"
	if paneOpened is "1" then
		my logStep(2, "pane already opened by Node, waiting")
		delay 1.5
	else
		my logStep(2, "opening Apple Account pane")
		my openAppleAccountPane()
		delay 2.5
	end if

	tell application "System Events"
		tell process "System Settings"
			try
				set _n to count of windows
				set _cls to class of window 1 as text
				if _cls is "" then
					error "Automation partial: UI class empty (-1743/partial)" number -1743
				end if
			on error errMsg number errNum
				if errNum is -1743 then
					error "缺少自动化权限 (-1743)：请在 系统设置 → 隐私与安全性 → 自动化 中允许 Terminal（或 Cursor）控制「系统设置」。"
				end if
				error "System Events 无法访问系统设置: " & errMsg & " (" & errNum & ")"
			end try

			set frontmost to true
			delay 0.6
			my logStep(3, "System Settings frontmost, windows=" & (count of windows))

			set targetWinIndex to 1
			set markers to {"一个账户", "电子邮件或电话号码", "Email or phone", "Email or Phone", "Sign in to your Apple", "尽享 Apple", "登录", "密码", "Password"}
			repeat 15 times
				if (count of windows) > 0 then
					set winCount to count of windows
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
							set targetWinIndex to wi
							exit repeat
						end if
					end repeat
					if matched then exit repeat
				end if
				my openAppleAccountPane()
				delay 1
			end repeat

			if (count of windows) is 0 then
				error "未找到 Apple 登录窗口（系统设置可能仍停留在辅助功能页）"
			end if

			set targetW to window targetWinIndex
			try
				set index of targetW to 1
			end try
			set frontmost to true
			delay 0.5

			set wTitle to ""
			try
				set wTitle to name of targetW
			end try
			my logStep(4, "target window index=" & targetWinIndex & " title=" & wTitle)

			-- BFS 找第 1 个非搜索文本框（邮箱）
			set emailResult to my bfsNthTextField(targetW, 1, 12)
			set emailFound to item 1 of emailResult
			set emailPath to item 2 of emailResult
			if not emailFound then
				error "未找到登录邮箱输入框（BFS 无非搜索文本栏）"
			end if
			my logStep(5, "found email field path=" & emailPath)

			set fieldVal to my fillFieldAtPath(targetW, emailPath, appleId)
			if fieldVal contains "@" then
				my logStep(6, "email fill verified contains @")
			else
				my logStep(6, "email fill fieldVal empty or no @")
			end if

			set emailFilled to false
			if fieldVal contains "@" then
				if fieldVal is appleId or fieldVal contains appleId or appleId contains fieldVal then
					set emailFilled to true
				end if
			end if
			if not emailFilled then
				error "邮箱未成功填入登录框。fieldVal=" & fieldVal
			end if
			my logStep(7, "email verified ok")

			delay 0.4
			set contNames to {"Continue", "继续", "Next", "下一步"}
			set clickedCont to my clickButtonNamed(targetW, contNames)
			if clickedCont then
				my logStep(8, "clicked Continue")
				delay 2
			else
				my logStep(8, "Continue not found — may be single-step login")
			end if

			-- 密码：重新 BFS 第 2 个文本框（或第 1 个若仅一个且已填邮箱）
			set pwdResult to my bfsNthTextField(targetW, 2, 12)
			set pwdFound to item 1 of pwdResult
			set pwdPath to item 2 of pwdResult

			if not pwdFound then
				set pwdResult to my bfsNthTextField(targetW, 1, 12)
				set pwdFound to item 1 of pwdResult
				set pwdPath to item 2 of pwdResult
			end if

			if pwdFound then
				my logStep(9, "found password field path=" & pwdPath)
				set pwdVal to my fillFieldAtPath(targetW, pwdPath, applePassword)
				my logStep(10, "password filled len=" & (count of pwdVal))
			else
				my logStep(9, "password field not visible — email-only phase done")
			end if

			delay 0.4
			set loginNames to {"Sign In", "Sign in", "登录", "登入", "Continue", "继续", "Next", "下一步"}
			if my clickButtonNamed(targetW, loginNames) then
				my logStep(11, "clicked login/submit")
			else
				my logStep(11, "login button not found, pressing Return")
				key code 36
			end if
		end tell
	end tell

	my logStep(12, "done ok")
	return "ok"
end run
