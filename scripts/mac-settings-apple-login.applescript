-- macOS 15 (Sequoia)：系统设置 → Apple Account 登录
-- 凭证：APPLE_SCRIPT_APPLE_ID、APPLE_SCRIPT_PASSWORD
-- v1.0.22：所有 UI 属性读取必须在 tell procRef 内（handler 会丢失 tell 上下文）

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

on ensureSettingsFrontmost(procRef)
	my forceActivateSettings(procRef)
end ensureSettingsFrontmost

on elementClassName(procRef, e)
	tell application "System Events"
		tell procRef
			try
				return class of e as text
			on error
				return ""
			end try
		end tell
	end tell
	return ""
end elementClassName

on isInputElement(procRef, e)
	set c to my elementClassName(procRef, e)
	return c is in {"text field", "text area", "combo box"}
end isInputElement

on elementDescription(procRef, e)
	set parts to {}
	tell application "System Events"
		tell procRef
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
		end tell
	end tell
	set merged to ""
	repeat with p in parts
		if p is not missing value and p is not "" then set merged to merged & p
	end repeat
	return merged
end elementDescription

on allInputFields(procRef, targetW)
	set found to {}
	tell application "System Events"
		tell procRef
			try
				repeat with e in entire contents of targetW
					if my isInputElement(procRef, e) then set end of found to e
				end repeat
			end try
			try
				repeat with e in entire contents of sheet 1 of targetW
					if my isInputElement(procRef, e) then set end of found to e
				end repeat
			end try
		end tell
	end tell
	return found
end allInputFields

on sidebarScrollArea(procRef, targetW)
	tell application "System Events"
		tell procRef
			try
				return scroll area 1 of group 1 of targetW
			end try
		end tell
	end tell
	return missing value
end sidebarScrollArea

on isInsideSidebar(procRef, e, targetW)
	set sidebar to my sidebarScrollArea(procRef, targetW)
	if sidebar is missing value then return false
	tell application "System Events"
		tell procRef
			try
				repeat with se in entire contents of sidebar
					if se is e then return true
				end repeat
			end try
		end tell
	end tell
	return false
end isInsideSidebar

on isSidebarSearchField(procRef, tf)
	if my textContainsAny(my elementDescription(procRef, tf), {"搜索", "Search", "search"}) then return true
	return false
end isSidebarSearchField

on textContainsAny(textValue, markers)
	if textValue is missing value or textValue is "" then return false
	repeat with marker in markers
		if textValue contains marker then return true
	end repeat
	return false
end textContainsAny

on mainPaneInputFieldsByPosition(procRef, targetW)
	set found to {}
	tell application "System Events"
		tell procRef
			try
				set winPos to position of targetW
				set winSize to size of targetW
				set minX to (item 1 of winPos) + (item 1 of winSize) * 0.22
				repeat with tf in my allInputFields(procRef, targetW)
					try
						set fp to position of tf
						if (item 1 of fp) >= minX then set end of found to tf
					end try
				end repeat
			end try
		end tell
	end tell
	return found
end mainPaneInputFieldsByPosition

on firstNonSearchField(procRef, targetW)
	repeat with tf in my allInputFields(procRef, targetW)
		if not my isSidebarSearchField(procRef, tf) then return tf
	end repeat
	return missing value
end firstNonSearchField

on nonSearchInputFields(procRef, targetW)
	set found to {}
	repeat with tf in my allInputFields(procRef, targetW)
		if not my isSidebarSearchField(procRef, tf) then set end of found to tf
	end repeat
	return found
end nonSearchInputFields

on resolveLoginInputFields(procRef, targetW)
	set fields to my mainPaneInputFields(procRef, targetW)
	if (count of fields) > 0 then return fields

	set fields to my mainPaneInputFieldsByPosition(procRef, targetW)
	if (count of fields) > 0 then return fields

	set fields to my nonSearchInputFields(procRef, targetW)
	if (count of fields) > 0 then return fields

	return my allInputFields(procRef, targetW)
end resolveLoginInputFields

on mainPaneInputFields(procRef, targetW)
	set found to {}
	repeat with tf in my allInputFields(procRef, targetW)
		if not my isInsideSidebar(procRef, tf, targetW) then set end of found to tf
	end repeat
	return found
end mainPaneInputFields

on fieldValue(procRef, tf)
	tell application "System Events"
		tell procRef
			try
				return value of tf
			on error
				return ""
			end try
		end tell
	end tell
	return ""
end fieldValue

on fieldMatchesMarkers(procRef, tf, markers)
	tell application "System Events"
		tell procRef
			repeat with marker in markers
				try
					if description of tf contains marker then return true
				end try
				try
					if title of tf contains marker then return true
				end try
			end repeat
		end tell
	end tell
	return false
end fieldMatchesMarkers

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

on windowContainsAppleId(procRef, targetW, appleId)
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
		end tell
	end tell
	return false
end windowContainsAppleId

on getFocusedElementValue(procRef)
	tell application "System Events"
		tell procRef
			try
				set f to value of attribute "AXFocusedUIElement"
				try
					return value of f as text
				on error
					try
						return description of f as text
					end try
				end try
			end try
			try
				repeat with w in windows
					repeat with e in entire contents of w
						try
							if focused of e then return value of e as text
						end try
					end repeat
				end repeat
			end try
		end tell
	end tell
	return ""
end getFocusedElementValue

on focusedContainsAppleId(procRef, appleId)
	set fv to my getFocusedElementValue(procRef)
	if fv contains appleId or fv is appleId then return true
	return false
end focusedContainsAppleId

on emailFillSucceeded(procRef, targetW, appleId)
	repeat with tf in my allInputFields(procRef, targetW)
		if my isSidebarSearchField(procRef, tf) then
			-- skip sidebar search
		else
			set v to my fieldValue(procRef, tf)
			if v contains appleId or v is appleId then return true
		end if
	end repeat
	if my windowContainsAppleId(procRef, targetW, appleId) then return true
	if my focusedContainsAppleId(procRef, appleId) then return true
	if my continueButtonEnabled(procRef, targetW) then return true
	return false
end emailFillSucceeded

on dumpLoginUiDebug(procRef, targetW, appleId)
	set msg to "[debug] "
	set allFields to my allInputFields(procRef, targetW)
	set msg to msg & "allFields=" & (count of allFields) & " "
	set msg to msg & "mainPane=" & (count of (my mainPaneInputFields(procRef, targetW))) & " "
	set msg to msg & "continue=" & my continueButtonEnabled(procRef, targetW) & " "
	set msg to msg & "containsId=" & my windowContainsAppleId(procRef, targetW, appleId) & " "
	set msg to msg & "focused=" & my getFocusedElementValue(procRef)
	do shell script "echo " & quoted form of msg & " >&2"
end dumpLoginUiDebug

on verifyEmailFilled(procRef, targetW, appleId, usedCoordinatePaste)
	if my emailFillSucceeded(procRef, targetW, appleId) then return
	if my continueButtonEnabled(procRef, targetW) then return
	if my focusedContainsAppleId(procRef, appleId) then return
	if usedCoordinatePaste and not my searchFieldContains(procRef, targetW, appleId) then
		-- 坐标粘贴后 AX 树可能仍为空；侧边栏未误填则视为成功
		return
	end if
	my dumpLoginUiDebug(procRef, targetW, appleId)
	error "邮箱未成功填入登录框 (-2700)。请在 隐私与安全性 → 自动化 中允许 Terminal/Cursor 控制「系统设置」。"
end verifyEmailFilled

on typeIntoFieldV07(procRef, tf, textValue)
	my forceActivateSettings(procRef)
	tell application "System Events"
		tell procRef
			click tf
			delay 0.3
			try
				set value of tf to ""
			end try
			delay 0.12
			try
				set value of tf to textValue
			on error errMsg number errNum
				error "set value 失败: " & errMsg & " (" & errNum & ")"
			end try
		end tell
	end tell
end typeIntoFieldV07

on pasteIntoFieldV07(procRef, tf, textValue)
	set the clipboard to textValue
	my forceActivateSettings(procRef)
	tell application "System Events"
		tell procRef
			click tf
			delay 0.35
			keystroke "a" using command down
			delay 0.08
			keystroke "v" using command down
		end tell
	end tell
end pasteIntoFieldV07

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

on pasteAtCoordinate(procRef, targetW, clickX, clickY, textValue)
	set the clipboard to textValue
	my forceActivateSettings(procRef)
	tell application "System Events"
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
					my pasteAtCoordinate(procRef, targetW, clickX, clickY, appleId)
					delay 0.75
					if my emailFillSucceeded(procRef, targetW, appleId) then return true
				end repeat
			end repeat
		end tell
	end tell
	return false
end pasteEmailViaGrid

on focusAndSetValue(procRef, tf, textValue)
	if my isSidebarSearchField(procRef, tf) then return false
	my forceActivateSettings(procRef)
	tell application "System Events"
		tell procRef
			try
				set focused of tf to true
			end try
			click tf
			delay 0.25
			try
				set value of tf to textValue
				return true
			on error
				return false
			end try
		end tell
	end tell
end focusAndSetValue

on focusAndPasteIntoField(procRef, tf, textValue)
	if my isSidebarSearchField(procRef, tf) then return false
	set the clipboard to textValue
	my forceActivateSettings(procRef)
	tell application "System Events"
		tell procRef
			try
				set focused of tf to true
			end try
			click tf
			delay 0.3
			keystroke "a" using command down
			delay 0.08
			keystroke "v" using command down
		end tell
	end tell
	return true
end focusAndPasteIntoField

on tryClickElement(procRef, e)
	tell application "System Events"
		tell procRef
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
		end tell
	end tell
	return false
end tryClickElement

on clickEmailFieldByMarker(procRef, targetW)
	tell application "System Events"
		tell procRef
			repeat with e in entire contents of targetW
				set desc to my elementDescription(procRef, e)
				if my textContainsAny(desc, {"电子邮件", "Email or", "email or", "phone number", "电话", "必填", "Required"}) then
					if my tryClickElement(procRef, e) then return true
				end if
				try
					set roleDesc to value of attribute "AXRoleDescription" of e
					if roleDesc is "文本栏" or roleDesc contains "text field" or roleDesc contains "Text Field" then
						if my tryClickElement(procRef, e) then return true
					end if
				end try
				try
					if class of e as text is "group" then
						set roleDesc to value of attribute "AXRoleDescription" of e
						if roleDesc is "文本栏" or roleDesc contains "text" then
							if my tryClickElement(procRef, e) then return true
						end if
					end if
				end try
				try
					if value of e is "电子邮件或电话号码" or value of e is "Email or Phone Number" then
						if my tryClickElement(procRef, e) then return true
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
		try
			keystroke "v" using command down
		on error errMsg number errNum
			my checkPasteAutomationPermission(procRef)
			error "粘贴失败: " & errMsg & " (" & errNum & ")"
		end try
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

on tryFillEmailOnField(procRef, targetW, tf, appleId)
	if my isSidebarSearchField(procRef, tf) then return false
	my focusAndSetValue(procRef, tf, appleId)
	delay 0.55
	if my emailFillSucceeded(procRef, targetW, appleId) then return true
	my focusAndPasteIntoField(procRef, tf, appleId)
	delay 0.65
	if my emailFillSucceeded(procRef, targetW, appleId) then return true
	return false
end tryFillEmailOnField

on fillEmailInWindow(procRef, targetW, appleId)
	my forceActivateSettings(procRef)
	delay 1.0

	if my emailFillSucceeded(procRef, targetW, appleId) then return {true, false}

	set allFields to my allInputFields(procRef, targetW)
	set fieldCount to count of allFields
	set usedCoordinatePaste to false

	if fieldCount is 0 then
		set usedCoordinatePaste to true
		if my fillEmailZeroFieldPath(procRef, targetW, appleId) then return {true, usedCoordinatePaste}
	else
		set emailField to missing value
		repeat with tf in allFields
			if not my isSidebarSearchField(procRef, tf) then
				set emailField to tf
				exit repeat
			end if
		end repeat
		if emailField is missing value and fieldCount > 0 then
			set emailField to item 1 of allFields
		end if

		if emailField is not missing value then
			my typeIntoFieldV07(procRef, emailField, appleId)
			delay 0.6
			if my emailFillSucceeded(procRef, targetW, appleId) then return {true, usedCoordinatePaste}
			my pasteIntoFieldV07(procRef, emailField, appleId)
			delay 0.7
			if my emailFillSucceeded(procRef, targetW, appleId) then return {true, usedCoordinatePaste}
		end if

		set usedCoordinatePaste to true
		if my fillEmailByClickAndPaste(procRef, targetW, appleId) then return {true, usedCoordinatePaste}
		if my pasteEmailViaGrid(procRef, targetW, appleId) then return {true, usedCoordinatePaste}
	end if

	my verifyEmailFilled(procRef, targetW, appleId, usedCoordinatePaste)
	return {true, usedCoordinatePaste}
end fillEmailInWindow

on findPasswordFieldInMainPane(procRef, targetW, appleId)
	set fields to my resolveLoginInputFields(procRef, targetW)
	repeat with tf in fields
		if my fieldMatchesMarkers(procRef, tf, {"密码", "Password"}) then return tf
	end repeat
	if (count of fields) >= 2 then
		repeat with tf in fields
			if not my fieldMatchesMarkers(procRef, tf, {"电子邮件", "Email", "phone", "电话", "Phone"}) then
				set v to my fieldValue(procRef, tf)
				if v does not contain "@" and v is not appleId then return tf
			end if
		end repeat
		return item 2 of fields
	end if
	return missing value
end findPasswordFieldInMainPane

on waitForPasswordFieldInMainPane(procRef, targetW, appleId, maxWaitSec)
	repeat maxWaitSec times
		set pw to my findPasswordFieldInMainPane(procRef, targetW, appleId)
		if pw is not missing value then return pw
		if my windowMatchesMarker(procRef, targetW, "密码") or my windowMatchesMarker(procRef, targetW, "Password") then
			set pw to my findPasswordFieldInMainPane(procRef, targetW, appleId)
			if pw is not missing value then return pw
		end if
		delay 0.5
	end repeat
	return missing value
end waitForPasswordFieldInMainPane

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
				my pasteAtCoordinate(procRef, targetW, clickX, clickY, applePassword)
				delay 0.55
				if not my searchFieldContains(procRef, targetW, applePassword) then return true
			end repeat
		end tell
	end tell
	return false
end pastePasswordViaCoordinates

on fillPasswordInWindow(procRef, targetW, appleId, applePassword)
	my forceActivateSettings(procRef)
	delay 0.8

	set passField to my waitForPasswordFieldInMainPane(procRef, targetW, appleId, 8)
	if passField is not missing value then
		my pasteIntoFieldV07(procRef, passField, applePassword)
	else
		set the clipboard to applePassword
		my forceActivateSettings(procRef)
		tell application "System Events"
			try
				keystroke "v" using command down
			on error errMsg number errNum
				my checkPasteAutomationPermission(procRef)
				error "密码粘贴失败: " & errMsg & " (" & errNum & ")"
			end try
		end tell
		delay 0.45
		if my searchFieldContains(procRef, targetW, applePassword) then
			my pastePasswordViaCoordinates(procRef, targetW, applePassword)
		end if
	end if

	my verifyPasswordNotInSearch(procRef, targetW, applePassword)
	return true
end fillPasswordInWindow

on searchFieldContains(procRef, targetW, textValue)
	tell application "System Events"
		tell procRef
			repeat with e in entire contents of targetW
				if my isInputElement(procRef, e) and my isSidebarSearchField(procRef, e) then
					try
						if value of e contains textValue then return true
					end try
				end if
				if my isInputElement(procRef, e) and my isInsideSidebar(procRef, e, targetW) then
					try
						if value of e contains textValue then return true
					end try
				end if
			end repeat
		end tell
	end tell
	return false
end searchFieldContains

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
