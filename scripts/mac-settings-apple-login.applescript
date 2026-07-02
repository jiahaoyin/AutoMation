-- macOS 15 (Sequoia)：系统设置 → Apple Account 登录填表
-- 凭证通过环境变量传入：APPLE_SCRIPT_APPLE_ID、APPLE_SCRIPT_PASSWORD

on loginPageMarkers()
	return {"一个账户", "电子邮件或电话号码", "Email or phone", "Email or Phone", "Sign in to your Apple", "尽享 Apple", "登录"}
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
				try
					if name of e contains marker then return true
				end try
			end repeat
		end try
	end tell
	return false
end windowMatchesMarker

on findLoginWindow(procRef)
	tell application "System Events"
		tell procRef
			set markers to my loginPageMarkers()
			repeat with w in windows
				repeat with marker in markers
					if my windowMatchesMarker(w, marker) then
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
				if my windowMatchesMarker(targetW, marker) then return targetW
			end repeat
		end if
		my openAppleAccountPane()
		delay 1
	end repeat
	return my findLoginWindow(procRef)
end waitForLoginWindow

on clickButtonNamedInWindow(targetW, buttonLabels)
	tell application "System Events"
		repeat with btnName in buttonLabels
			try
				click button btnName of targetW
				return true
			end try
			try
				click (first button of targetW whose name is btnName)
				return true
			end try
			try
				click button btnName of sheet 1 of targetW
				return true
			end try
		end repeat
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

on typeIntoField(tf, textValue, useKeystroke)
	tell application "System Events"
		click tf
		delay 0.25
		try
			set value of tf to ""
		end try
		delay 0.15
		if useKeystroke then
			keystroke textValue
		else
			try
				set value of tf to textValue
			on error
				keystroke textValue
			end try
		end if
	end tell
end typeIntoField

on elementClassName(e)
	try
		return class of e as text
	on error
		return ""
	end try
end elementClassName

on isInputElement(e)
	set c to my elementClassName(e)
	return c is in {"text field", "text area", "combo box"}
end isInputElement

on deepInputFieldsOfWindow(targetW)
	set found to {}
	tell application "System Events"
		try
			repeat with e in entire contents of targetW
				if my isInputElement(e) then set end of found to e
			end repeat
		end try
		try
			repeat with e in entire contents of sheet 1 of targetW
				if my isInputElement(e) then set end of found to e
			end repeat
		end try
	end tell
	return found
end deepInputFieldsOfWindow

on clickInputLabelInWindow(targetW, labelTexts)
	tell application "System Events"
		repeat with lbl in labelTexts
			try
				click (first static text of targetW whose value is lbl)
				return true
			end try
			try
				repeat with e in entire contents of targetW
					try
						if value of e is lbl then
							click e
							return true
						end if
					end try
				end repeat
			end try
		end repeat
	end tell
	return false
end clickInputLabelInWindow

on typeViaFocusInWindow(procRef, targetW, textValue, useKeystroke, labelTexts)
	set focused to false
	if labelTexts is not {} then
		set focused to my clickInputLabelInWindow(targetW, labelTexts)
	end if
	if not focused then
		set fields to my deepInputFieldsOfWindow(targetW)
		if (count of fields) > 0 then
			tell application "System Events" to click item 1 of fields
			set focused to true
		end if
	end if
	if not focused then
		tell application "System Events"
			tell procRef
				set frontmost to true
			end tell
			try
				click targetW
			end try
			delay 0.2
			key code 48
		end tell
	end if
	delay 0.3
	tell application "System Events"
		keystroke textValue
	end tell
	return true
end typeViaFocusInWindow

on fillEmailInWindow(procRef, targetW, appleId)
	set emailLabels to {"电子邮件或电话号码", "Email or Phone Number", "Email or phone number"}
	set fields to my deepInputFieldsOfWindow(targetW)
	if (count of fields) > 0 then
		my typeIntoField(item 1 of fields, appleId, false)
		return true
	end if
	my typeViaFocusInWindow(procRef, targetW, appleId, false, emailLabels)
	return true
end fillEmailInWindow

on waitForPasswordFieldInWindow(targetW, appleId, maxWaitSec)
	repeat maxWaitSec times
		set fields to my deepInputFieldsOfWindow(targetW)
		repeat with tf in fields
			try
				tell application "System Events"
					set v to value of tf
					if v is "" or v is not appleId then return tf
				end tell
			end try
		end repeat
		delay 1
	end repeat
	return missing value
end waitForPasswordFieldInWindow

on readCredentials()
	set appleId to system attribute "APPLE_SCRIPT_APPLE_ID"
	set applePassword to system attribute "APPLE_SCRIPT_PASSWORD"
	if appleId is missing value or appleId is "" then error "缺少 APPLE_SCRIPT_APPLE_ID"
	if applePassword is missing value or applePassword is "" then error "缺少 APPLE_SCRIPT_PASSWORD"
	return {appleId, applePassword}
end readCredentials

on run argv
	set creds to my readCredentials()
	set appleId to item 1 of creds
	set applePassword to item 2 of creds

	tell application "System Settings" to activate
	delay 0.5
	my openAppleAccountPane()
	delay 2

	tell application "System Events"
		tell process "System Settings"
			set frontmost to true
			delay 0.5

			set targetW to my waitForLoginWindow(it, 12)
			if targetW is missing value then
				error "未找到 Apple 登录窗口（系统设置可能仍停留在辅助功能页）"
			end if

			set hasLoginContent to false
			repeat with marker in my loginPageMarkers()
				if my windowMatchesMarker(targetW, marker) then
					set hasLoginContent to true
					exit repeat
				end if
			end repeat

			if not hasLoginContent then
				my clickSidebarAppleAccount(it, targetW)
				delay 1.2
				my clickButtonNamedInWindow(targetW, {"Sign In", "Sign in", "登录", "登入"})
				delay 2
				set targetW to my findLoginWindow(it)
			end if

			my fillEmailInWindow(it, targetW, appleId)
			delay 0.8
			if not my clickButtonNamedInWindow(targetW, {"Continue", "继续", "Next", "下一步"}) then
				key code 36
			end if
			delay 2.5

			set targetW to my findLoginWindow(it)
			set passField to my waitForPasswordFieldInWindow(targetW, appleId, 15)
			if passField is not missing value then
				my typeIntoField(passField, applePassword, true)
			else
				my typeViaFocusInWindow(it, targetW, applePassword, true, {"密码", "Password"})
			end if

			delay 0.8
			if not my clickButtonNamedInWindow(targetW, {"Continue", "继续", "Sign In", "Sign in", "登录", "Next", "下一步"}) then
				if not my clickButtonNamedInWindow(targetW, {"Continue", "继续", "Sign In", "登录"}) then
					key code 36
				end if
			end if
		end tell
	end tell

	return "ok"
end run
