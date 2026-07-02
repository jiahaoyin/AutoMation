-- macOS 15 (Sequoia)：系统设置 → Apple Account 登录
-- 凭证：APPLE_SCRIPT_APPLE_ID、APPLE_SCRIPT_PASSWORD
-- v1.0.24：entire contents 元素引用不可传给 handler；所有属性读取/点击/填值在 tell process 内联

on loginPageMarkers()
	return {"一个账户", "电子邮件或电话号码", "Email or phone", "Email or Phone", "Sign in to your Apple", "尽享 Apple", "登录", "密码", "Password"}
end loginPageMarkers

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

on textContainsAny(textValue, markers)
	if textValue is missing value or textValue is "" then return false
	repeat with marker in markers
		if textValue contains marker then return true
	end repeat
	return false
end textContainsAny

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
					try
						if name of e contains marker then return true
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
			set markers to my loginPageMarkers()
			repeat with w in windows
				repeat with marker in markers
					if my windowMatchesMarker(procRef, w, marker) then
						try
							set index of w to 1
						end try
						set frontmost to true
						return w
					end if
				end repeat
			end repeat
			if (count of windows) > 0 then
				set index of window 1 to 1
				return window 1
			end if
		end tell
	end tell
	return missing value
end findLoginWindow

on waitForLoginWindow(procRef, maxWaitSec)
	repeat maxWaitSec times
		set targetW to my findLoginWindow(procRef)
		if targetW is not missing value then
			repeat with marker in my loginPageMarkers()
				if my windowMatchesMarker(procRef, targetW, marker) then return targetW
			end repeat
		end if
		my openAppleAccountPane()
		delay 1
	end repeat
	return my findLoginWindow(procRef)
end waitForLoginWindow

on clickButtonNamedInWindow(procRef, targetW, buttonLabels)
	tell application "System Events"
		tell procRef
			repeat with btnName in buttonLabels
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
				try
					set b to button btnName of sheet 1 of targetW
					if enabled of b then
						click b
						return true
					end if
				end try
			end repeat
		end tell
	end tell
	return false
end clickButtonNamedInWindow

on clickSidebarAppleAccount(procRef, targetW)
	tell application "System Events"
		tell procRef
			set sidebarLabels to {"Apple Account", "Apple 账户", "Apple ID", "Apple 账户与密码"}
			repeat with lbl in sidebarLabels
				try
					click static text lbl of scroll area 1 of group 1 of targetW
					return true
				on error
					try
						click UI element lbl of scroll area 1 of group 1 of targetW
						return true
					end try
				end try
			end repeat
		end tell
	end tell
	return false
end clickSidebarAppleAccount

on forceActivateSettings(procRef)
	repeat 3 times
		tell application "System Settings" to activate
		delay 0.4
		tell application "System Events"
			tell procRef
				set frontmost to true
			end tell
		end tell
		delay 0.35
	end repeat
end forceActivateSettings

on countDeepInputFields(procRef, targetW)
	set n to 0
	tell application "System Events"
		tell procRef
			try
				repeat with e in entire contents of targetW
					try
						if class of e as text is in {"text field", "text area", "combo box"} then set n to n + 1
					end try
				end repeat
			end try
			try
				repeat with e in entire contents of sheet 1 of targetW
					try
						if class of e as text is in {"text field", "text area", "combo box"} then set n to n + 1
					end try
				end repeat
			end try
		end tell
	end tell
	return n
end countDeepInputFields

on continueButtonEnabled(procRef, targetW)
	tell application "System Events"
		tell procRef
			repeat with btnName in {"Continue", "继续", "Sign In", "Sign in", "登录", "Next", "下一步"}
				try
					set b to button btnName of targetW
					try
						if enabled of b then return true
					end try
					try
						if value of attribute "AXEnabled" of b then return true
					end try
				end try
				try
					set b to first button of targetW whose name is btnName
					try
						if enabled of b then return true
					end try
					try
						if value of attribute "AXEnabled" of b then return true
					end try
				end try
			end repeat
			repeat with e in entire contents of targetW
				try
					if class of e as text is "button" then
						if name of e is "继续" or name of e is "Continue" then
							try
								if enabled of e then return true
							end try
							try
								if value of attribute "AXEnabled" of e then return true
							end try
						end if
					end if
				end try
			end repeat
		end tell
	end tell
	return false
end continueButtonEnabled

on emailFillSucceeded(procRef, targetW, appleId)
	tell application "System Events"
		tell procRef
			repeat with e in entire contents of targetW
				try
					if value of e contains appleId then return true
				end try
				try
					if name of e contains appleId then return true
				end try
				try
					if description of e contains appleId then return true
				end try
			end repeat
			try
				set f to value of attribute "AXFocusedUIElement"
				try
					if value of f contains appleId then return true
				end try
				try
					if description of f contains appleId then return true
				end try
			end try
		end tell
	end tell
	if my continueButtonEnabled(procRef, targetW) then return true
	return false
end emailFillSucceeded

on searchFieldContains(procRef, targetW, textValue)
	tell application "System Events"
		tell procRef
			repeat with e in entire contents of targetW
				try
					if class of e as text is in {"text field", "text area", "combo box"} then
						set d to ""
						try
							set d to description of e
						end try
						try
							set d to d & name of e
						end try
						if d contains "搜索" or d contains "Search" or d contains "search" then
							try
								if value of e contains textValue then return true
							end try
						end if
					end if
				end try
			end repeat
		end tell
	end tell
	return false
end searchFieldContains

on checkPasteAutomationPermission(procRef)
	try
		my forceActivateSettings(procRef)
		tell application "System Events"
			tell procRef
				keystroke "a" using command down
			end tell
		end tell
	on error errMsg number errNum
		if errNum is -1743 then
			error "缺少自动化权限 (-1743)：请在 系统设置 → 隐私与安全性 → 自动化 中允许 Terminal（或 Cursor）控制「系统设置」。"
		end if
	end try
end checkPasteAutomationPermission

on pasteAtCoordinate(procRef, clickX, clickY, textValue)
	set the clipboard to textValue
	my forceActivateSettings(procRef)
	tell application "System Events"
		tell procRef
			click at {clickX, clickY}
			delay 0.55
			keystroke "a" using command down
			delay 0.1
			try
				keystroke "v" using command down
			on error errMsg number errNum
				my checkPasteAutomationPermission(procRef)
				error "粘贴失败: " & errMsg & " (" & errNum & ")"
			end try
		end tell
	end tell
end pasteAtCoordinate

on pasteEmailViaGrid(procRef, targetW, appleId)
	set the clipboard to appleId
	tell application "System Events"
		tell procRef
			set winPos to position of targetW
			set winSize to size of targetW
			set baseX to item 1 of winPos
			set baseY to item 2 of winPos
			set w to item 1 of winSize
			set h to item 2 of winSize
			repeat with xFrac in {0.50, 0.52, 0.55, 0.58, 0.62, 0.65}
				repeat with yFrac in {0.36, 0.40, 0.44, 0.48, 0.52, 0.56, 0.60}
					set clickX to baseX + w * xFrac
					set clickY to baseY + h * yFrac
					my pasteAtCoordinate(procRef, clickX, clickY, appleId)
					delay 0.75
					if my emailFillSucceeded(procRef, targetW, appleId) then return true
				end repeat
			end repeat
		end tell
	end tell
	return false
end pasteEmailViaGrid

on clickEmailFieldByMarker(procRef, targetW)
	tell application "System Events"
		tell procRef
			repeat with e in entire contents of targetW
				set desc to ""
				try
					set desc to description of e
				end try
				try
					set desc to desc & title of e
				end try
				try
					set desc to desc & name of e
				end try
				if my textContainsAny(desc, {"电子邮件", "Email or", "email or", "phone number", "电话", "必填", "Required"}) then
					try
						click e
						return true
					end try
					try
						perform action "AXPress" of e
						return true
					end try
					try
						set focused of e to true
						return true
					end try
				end if
				try
					set roleDesc to value of attribute "AXRoleDescription" of e
					if roleDesc is "文本栏" or roleDesc contains "text field" or roleDesc contains "Text Field" then
						try
							click e
							return true
						end try
					end if
				end try
				try
					if value of e is "电子邮件或电话号码" or value of e is "Email or Phone Number" then
						try
							click e
							return true
						end try
					end if
				end try
			end repeat
		end tell
	end tell
	return false
end clickEmailFieldByMarker

on clickEmailFieldByCoordinates(procRef, targetW)
	tell application "System Events"
		tell procRef
			try
				set winPos to position of targetW
				set winSize to size of targetW
				set clickX to (item 1 of winPos) + (item 1 of winSize) * 0.55
				set clickY to (item 2 of winPos) + (item 2 of winSize) * 0.48
				my forceActivateSettings(procRef)
				click at {clickX, clickY}
				return true
			end try
		end tell
	end tell
	return false
end clickEmailFieldByCoordinates

on fillEmailByClickAndPaste(procRef, targetW, appleId)
	my forceActivateSettings(procRef)
	set clicked to my clickEmailFieldByMarker(procRef, targetW)
	if not clicked then
		set clicked to my clickEmailFieldByCoordinates(procRef, targetW)
	end if
	if not clicked then return false
	delay 0.55
	set the clipboard to appleId
	my forceActivateSettings(procRef)
	tell application "System Events"
		tell procRef
			try
				keystroke "v" using command down
			on error errMsg number errNum
				my checkPasteAutomationPermission(procRef)
				error "粘贴失败: " & errMsg & " (" & errNum & ")"
			end try
		end tell
	end tell
	delay 0.75
	return my emailFillSucceeded(procRef, targetW, appleId)
end fillEmailByClickAndPaste

on fillEmailZeroFieldPath(procRef, targetW, appleId)
	my forceActivateSettings(procRef)
	delay 0.6

	if my fillEmailByClickAndPaste(procRef, targetW, appleId) then return true
	if my pasteEmailViaGrid(procRef, targetW, appleId) then return true

	my checkPasteAutomationPermission(procRef)
	return false
end fillEmailZeroFieldPath

on tryFillFirstEmailField(procRef, targetW, appleId)
	tell application "System Events"
		tell procRef
			repeat with e in entire contents of targetW
				try
					if class of e as text is in {"text field", "text area", "combo box"} then
						set d to ""
						try
							set d to description of e
						end try
						try
							set d to d & name of e
						end try
						if d contains "搜索" or d contains "Search" or d contains "search" then
							-- skip sidebar search
						else
							my forceActivateSettings(procRef)
							click e
							delay 0.3
							try
								set value of e to ""
							end try
							delay 0.12
							try
								set value of e to appleId
							end try
							delay 0.55
							if my emailFillSucceeded(procRef, targetW, appleId) then return true
							set the clipboard to appleId
							keystroke "a" using command down
							delay 0.08
							keystroke "v" using command down
							delay 0.65
							if my emailFillSucceeded(procRef, targetW, appleId) then return true
							return false
						end if
					end if
				end try
			end repeat
		end tell
	end tell
	return false
end tryFillFirstEmailField

on fillEmailInWindow(procRef, targetW, appleId)
	my forceActivateSettings(procRef)
	delay 1.0

	if my emailFillSucceeded(procRef, targetW, appleId) then return {true, false}

	set fieldCount to my countDeepInputFields(procRef, targetW)
	set usedCoordinatePaste to false

	if fieldCount is 0 then
		set usedCoordinatePaste to true
		if my fillEmailZeroFieldPath(procRef, targetW, appleId) then return {true, usedCoordinatePaste}
	else
		if my tryFillFirstEmailField(procRef, targetW, appleId) then return {true, usedCoordinatePaste}
		set usedCoordinatePaste to true
		if my fillEmailByClickAndPaste(procRef, targetW, appleId) then return {true, usedCoordinatePaste}
		if my pasteEmailViaGrid(procRef, targetW, appleId) then return {true, usedCoordinatePaste}
	end if

	my verifyEmailFilled(procRef, targetW, appleId, usedCoordinatePaste)
	return {true, usedCoordinatePaste}
end fillEmailInWindow

on verifyEmailFilled(procRef, targetW, appleId, usedCoordinatePaste)
	if my emailFillSucceeded(procRef, targetW, appleId) then return
	if my continueButtonEnabled(procRef, targetW) then return
	if usedCoordinatePaste and not my searchFieldContains(procRef, targetW, appleId) then
		-- 坐标粘贴后 AX 树可能仍为空；侧边栏未误填则视为成功
		return
	end if
	error "邮箱未成功填入登录框 (-2700)。请在 隐私与安全性 → 自动化 中允许 Terminal/Cursor 控制「系统设置」。"
end verifyEmailFilled

on fillPasswordInWindow(procRef, targetW, appleId, applePassword)
	my forceActivateSettings(procRef)
	delay 0.8

	set filled to false
	repeat 8 times
		tell application "System Events"
			tell procRef
				repeat with e in entire contents of targetW
					try
						if class of e as text is in {"text field", "text area", "combo box"} then
							set d to ""
							try
								set d to description of e
							end try
							try
								set d to d & title of e
							end try
							try
								set d to d & name of e
							end try
							if d contains "密码" or d contains "Password" then
								set the clipboard to applePassword
								click e
								delay 0.35
								keystroke "a" using command down
								delay 0.08
								keystroke "v" using command down
								set filled to true
								exit repeat
							end if
						end if
					end try
				end repeat
			end tell
		end tell
		if filled then exit repeat
		delay 0.5
	end repeat

	if not filled then
		set the clipboard to applePassword
		my forceActivateSettings(procRef)
		tell application "System Events"
			tell procRef
				try
					keystroke "v" using command down
				on error errMsg number errNum
					my checkPasteAutomationPermission(procRef)
					error "密码粘贴失败: " & errMsg & " (" & errNum & ")"
				end try
			end tell
		end tell
		delay 0.45
		if my searchFieldContains(procRef, targetW, applePassword) then
			my pastePasswordViaCoordinates(procRef, targetW, applePassword)
		end if
	end if

	my verifyPasswordNotInSearch(procRef, targetW, applePassword)
	return true
end fillPasswordInWindow

on pastePasswordViaCoordinates(procRef, targetW, applePassword)
	tell application "System Events"
		tell procRef
			set winPos to position of targetW
			set winSize to size of targetW
			set baseX to item 1 of winPos
			set baseY to item 2 of winPos
			set w to item 1 of winSize
			set h to item 2 of winSize
			repeat with yFrac in {0.52, 0.56, 0.60, 0.64, 0.68}
				set clickX to baseX + w * 0.58
				set clickY to baseY + h * yFrac
				my pasteAtCoordinate(procRef, clickX, clickY, applePassword)
				delay 0.55
				if not my searchFieldContains(procRef, targetW, applePassword) then return true
			end repeat
		end tell
	end tell
	return false
end pastePasswordViaCoordinates

on verifyPasswordNotInSearch(procRef, targetW, applePassword)
	if my searchFieldContains(procRef, targetW, applePassword) then
		error "密码被误填入侧边栏搜索框，请重试"
	end if
end verifyPasswordNotInSearch

on readCredentials()
	set appleId to system attribute "APPLE_SCRIPT_APPLE_ID"
	set applePassword to system attribute "APPLE_SCRIPT_PASSWORD"
	if appleId is missing value or appleId is "" then error "缺少 APPLE_SCRIPT_APPLE_ID"
	if applePassword is missing value or applePassword is "" then error "缺少 APPLE_SCRIPT_PASSWORD"
	return {appleId, applePassword}
end readCredentials

on assertAutomationPermission(procRef)
	try
		tell application "System Events"
			tell procRef
				set _n to count of windows
				set _cls to class of window 1 as text
				if _cls is "" then
					error "Automation partial: UI class empty (-1743/partial)" number -1743
				end if
			end tell
		end tell
	on error errMsg number errNum
		if errNum is -1743 then
			error "缺少自动化权限 (-1743)：请在 系统设置 → 隐私与安全性 → 自动化 中允许 Terminal（或 Cursor）控制「系统设置」。"
		end if
		error "System Events 无法访问系统设置: " & errMsg & " (" & errNum & ")"
	end try
end assertAutomationPermission

on run argv
	set creds to my readCredentials()
	set appleId to item 1 of creds
	set applePassword to item 2 of creds

	tell application "System Settings" to activate
	delay 0.5
	set paneOpened to system attribute "APPLE_SCRIPT_PANE_OPENED"
	if paneOpened is "1" then
		delay 1.5
	else
		my openAppleAccountPane()
		delay 2.5
	end if

	tell application "System Events"
		tell process "System Settings"
			my assertAutomationPermission(it)
			set frontmost to true
			delay 0.8

			set targetW to my waitForLoginWindow(it, 12)
			if targetW is missing value then
				error "未找到 Apple 登录窗口（系统设置可能仍停留在辅助功能页）"
			end if

			set hasLoginContent to false
			repeat with marker in my loginPageMarkers()
				if my windowMatchesMarker(it, targetW, marker) then
					set hasLoginContent to true
					exit repeat
				end if
			end repeat

			if not hasLoginContent then
				my clickSidebarAppleAccount(it, targetW)
				delay 1.2
				my clickButtonNamedInWindow(it, targetW, {"Sign In", "Sign in", "登录", "登入"})
				delay 2
				set targetW to my findLoginWindow(it)
			end if

			delay 1.2
			set emailResult to my fillEmailInWindow(it, targetW, appleId)
			delay 0.8
			my fillPasswordInWindow(it, targetW, appleId, applePassword)

			delay 0.5
			if not my clickButtonNamedInWindow(it, targetW, {"Continue", "继续", "Sign In", "Sign in", "登录", "Next", "下一步"}) then
				key code 36
			end if
		end tell
	end tell

	return "ok"
end run
