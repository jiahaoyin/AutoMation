-- macOS 15 (Sequoia)：系统设置 → Apple Account 登录
-- v1.0.28：按 AXIdentifier 精确定位登录控件；密码阶段重新解析动态 AX 路径
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

-- 在 parent 下按 BFS 找精确 AXIdentifier；不缓存跨状态转换的 AX 元素引用
-- 返回 {found, pathString}，pathString 如 "2/1/3"
using terms from application "System Events"
on bfsElementWithIdentifier(parentRef, wantedIdentifier, maxDepth)
	set tfQueueEls to {parentRef}
	set tfQueuePaths to {""}
	set tfQueueDepths to {0}
	set queueIndex to 1
	repeat 600 times
		if queueIndex > (count of tfQueueEls) then exit repeat
		set curEl to item queueIndex of tfQueueEls
		set curPath to item queueIndex of tfQueuePaths
		set curDepth to item queueIndex of tfQueueDepths
		set queueIndex to queueIndex + 1
		try
			set childCount to count of UI elements of curEl
			repeat with ci from 1 to childCount
				set childEl to UI element ci of curEl
				set identifierValue to ""
				try
					set identifierValue to value of attribute "AXIdentifier" of childEl as text
				end try
				set childPath to curPath
				if childPath is "" then
					set childPath to (ci as text)
				else
					set childPath to curPath & "/" & (ci as text)
				end if
				if identifierValue is wantedIdentifier then
					return {true, childPath}
				end if
				if curDepth < maxDepth then
					set end of tfQueueEls to childEl
					set end of tfQueuePaths to childPath
					set end of tfQueueDepths to (curDepth + 1)
				end if
			end repeat
		end try
	end repeat
	return {false, ""}
end bfsElementWithIdentifier

-- 每一轮从 live root 重新构建路径，避免 Continue 后 System Settings 重绘造成旧引用失效
on waitForIdentifierPath(parentRef, wantedIdentifier, maxAttempts, pauseSeconds)
	repeat maxAttempts times
		set identifierResult to my bfsElementWithIdentifier(parentRef, wantedIdentifier, 12)
		if item 1 of identifierResult then return identifierResult
		delay pauseSeconds
	end repeat
	return {false, ""}
end waitForIdentifierPath

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

-- A stored child-index path is only a locator hint. Re-check its live leaf before every action.
on resolveIdentifierPath(rootRef, pathString, wantedIdentifier)
	try
		set el to my resolvePath(rootRef, pathString)
		set identifierValue to ""
		try
			set identifierValue to value of attribute "AXIdentifier" of el as text
		end try
		if identifierValue is wantedIdentifier then return el
	end try
	return missing value
end resolveIdentifierPath

on fieldHasEnabledFocus(fieldEl)
	try
		if not (enabled of fieldEl) then return false
		if not (focused of fieldEl) then return false
		return true
	end try
	return false
end fieldHasEnabledFocus

on fillFieldAtPath(rootRef, pathString, textValue, verificationKind, wantedIdentifier)
	set fieldEl to my resolveIdentifierPath(rootRef, pathString, wantedIdentifier)
	if fieldEl is missing value then return {false, false}
	try
		if not (enabled of fieldEl) then return {false, false}
		click fieldEl
	on error
		try
			perform action "AXRaise" of fieldEl
		on error
			return {false, false}
		end try
	end try
	delay 0.35
	set fieldEl to my resolveIdentifierPath(rootRef, pathString, wantedIdentifier)
	if fieldEl is missing value then return {false, false}
	try
		if not (enabled of fieldEl) then return {false, false}
		set focused of fieldEl to true
	on error
		return {false, false}
	end try
	delay 0.12
	set fieldEl to my resolveIdentifierPath(rootRef, pathString, wantedIdentifier)
	if fieldEl is missing value then return {false, false}
	if not (my fieldHasEnabledFocus(fieldEl)) then return {false, false}

	set valueWriteAttempted to false
	try
		set value of fieldEl to textValue
		set valueWriteAttempted to true
	end try
	delay 0.2
	set fieldEl to my resolveIdentifierPath(rootRef, pathString, wantedIdentifier)
	if fieldEl is missing value then
		if valueWriteAttempted then return {true, false}
		return {false, false}
	end if
	if not (my fieldHasEnabledFocus(fieldEl)) then
		if valueWriteAttempted then return {true, false}
		return {false, false}
	end if

	set the clipboard to textValue
	keystroke "a" using command down
	delay 0.08
	set fieldEl to my resolveIdentifierPath(rootRef, pathString, wantedIdentifier)
	if fieldEl is missing value then return {true, false}
	if not (my fieldHasEnabledFocus(fieldEl)) then return {true, false}
	keystroke "v" using command down
	delay 0.45
	set fieldVal to ""
	try
		set fieldVal to value of fieldEl as text
	end try
	if verificationKind is "email" then
		if fieldVal is textValue then return {true, true}
		return {true, false}
	end if
	if verificationKind is "password" then
		set minimumLength to count of textValue
		if minimumLength > 4 then set minimumLength to 4
		if (count of fieldVal) is greater than or equal to minimumLength then return {true, true}
		return {true, false}
	end if
	return {true, false}
end fillFieldAtPath

-- Re-find only when a re-render invalidated the saved path; never repeat a failed credential write.
on fillIdentifierField(targetW, wantedIdentifier, textValue, verificationKind, maxAttempts, pauseSeconds)
	repeat maxAttempts times
		set fieldResult to my bfsElementWithIdentifier(targetW, wantedIdentifier, 12)
		if item 1 of fieldResult then
			set fillResult to my fillFieldAtPath(targetW, item 2 of fieldResult, textValue, verificationKind, wantedIdentifier)
			if item 1 of fillResult then return item 2 of fillResult
		end if
		delay pauseSeconds
	end repeat
	return false
end fillIdentifierField

-- LOGIN_BUTTON must be found by AXIdentifier and enabled before pressing it.
on clickLoginButton(targetW, maxAttempts, pauseSeconds)
	repeat maxAttempts times
		set buttonResult to my bfsElementWithIdentifier(targetW, "LOGIN_BUTTON", 12)
		if item 1 of buttonResult then
			try
				set buttonEl to my resolveIdentifierPath(targetW, item 2 of buttonResult, "LOGIN_BUTTON")
				if buttonEl is not missing value then
					if enabled of buttonEl then
						click buttonEl
						return true
					end if
				end if
			end try
		end if
		delay pauseSeconds
	end repeat
	return false
end clickLoginButton
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

			my logStep(4, "target login window index=" & targetWinIndex)

			-- 首屏的 Apple Account 输入框由 AXIdentifier 唯一标识，不能按文本框序号猜测。
			set emailResult to my waitForIdentifierPath(targetW, "USERNAME_TEXT_FIELD", 12, 0.25)
			set emailFound to item 1 of emailResult
			set emailPath to item 2 of emailResult
			if not emailFound then
				error "未找到登录邮箱输入框（USERNAME_TEXT_FIELD）"
			end if
			my logStep(5, "found USERNAME_TEXT_FIELD")

			set emailFilled to my fillIdentifierField(targetW, "USERNAME_TEXT_FIELD", appleId, "email", 3, 0.15)
			if not emailFilled then
				error "邮箱未成功填入登录框"
			end if
			my logStep(7, "email verified ok")

			delay 0.4
			set clickedCont to my clickLoginButton(targetW, 10, 0.2)
			if clickedCont then
				my logStep(8, "clicked Continue")
			else
				error "未找到或未启用登录继续按钮（LOGIN_BUTTON）"
			end if

			-- Continue 后窗口会重绘；每轮从当前窗口重新解析 PASSWORD_TEXT_FIELD 的路径。
			set pwdResult to my waitForIdentifierPath(targetW, "PASSWORD_TEXT_FIELD", 18, 0.35)
			set pwdFound to item 1 of pwdResult
			set pwdPath to item 2 of pwdResult

			if not pwdFound then
				error "未在限定时间内找到密码输入框（PASSWORD_TEXT_FIELD）"
			end if

			my logStep(9, "found PASSWORD_TEXT_FIELD")
			set passwordFilled to my fillIdentifierField(targetW, "PASSWORD_TEXT_FIELD", applePassword, "password", 3, 0.15)
			if not passwordFilled then
				error "密码未成功填入登录框"
			end if
			my logStep(10, "password verified ok")

			delay 0.4
			if my clickLoginButton(targetW, 10, 0.2) then
				my logStep(11, "clicked login/submit")
			else
				error "未找到或未启用登录提交按钮（LOGIN_BUTTON）"
			end if
		end tell
	end tell

	my logStep(12, "done ok")
	return "ok"
end run
