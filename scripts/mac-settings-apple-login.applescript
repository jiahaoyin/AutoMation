-- macOS 15 (Sequoia)：系统设置 → Apple Account 登录填表
-- 凭证通过环境变量传入：APPLE_SCRIPT_APPLE_ID、APPLE_SCRIPT_PASSWORD

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

on clickButtonNamed(procRef, buttonLabels)
	tell application "System Events"
		tell procRef
			repeat with w in windows
				repeat with btnName in buttonLabels
					try
						click button btnName of w
						return true
					end try
					try
						click (first button of w whose name is btnName)
						return true
					end try
					try
						click button btnName of sheet 1 of w
						return true
					end try
				end repeat
			end repeat
		end tell
	end tell
	return false
end clickButtonNamed

on clickSidebarAppleAccount(procRef)
	tell application "System Events"
		tell procRef
			set sidebarLabels to {"Apple Account", "Apple 账户", "Apple ID", "Apple 账户与密码"}
			repeat with lbl in sidebarLabels
				try
					click static text lbl of scroll area 1 of group 1 of window 1
					return true
				on error
					try
						click UI element lbl of scroll area 1 of group 1 of window 1
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

on deepInputFields(procRef)
	set found to {}
	tell application "System Events"
		tell procRef
			repeat with w in windows
				try
					repeat with e in entire contents of w
						if my isInputElement(e) then set end of found to e
					end repeat
				end try
				try
					repeat with e in entire contents of sheet 1 of w
						if my isInputElement(e) then set end of found to e
					end repeat
				end try
			end repeat
		end tell
	end tell
	return found
end deepInputFields

on windowContainsText(procRef, marker)
	tell application "System Events"
		tell procRef
			repeat with w in windows
				try
					if name of w contains marker then return true
				end try
				try
					repeat with e in entire contents of w
						try
							set t to value of e
							if t contains marker then return true
						end try
						try
							set t to name of e
							if t contains marker then return true
						end try
					end repeat
				end try
			end repeat
		end tell
	end tell
	return false
end windowContainsText

on isLoginPageVisible(procRef)
	set markers to {"一个账户", "电子邮件或电话号码", "Email or phone", "Email or Phone", "Sign in to your Apple", "尽享 Apple"}
	repeat with marker in markers
		if my windowContainsText(procRef, marker) then return true
	end repeat
	return false
end isLoginPageVisible

on clickInputLabel(procRef, labelTexts)
	tell application "System Events"
		tell procRef
			repeat with w in windows
				repeat with lbl in labelTexts
					try
						click (first static text of w whose value is lbl)
						return true
					end try
					try
						repeat with e in entire contents of w
							try
								if value of e is lbl then
									click e
									return true
								end if
							end try
						end repeat
					end try
				end repeat
			end repeat
		end tell
	end tell
	return false
end clickInputLabel

on typeViaFocus(procRef, textValue, useKeystroke, labelTexts)
	set focused to false
	if labelTexts is not {} then
		set focused to my clickInputLabel(procRef, labelTexts)
	end if
	if not focused then
		set fields to my deepInputFields(procRef)
		if (count of fields) > 0 then
			tell application "System Events" to click item 1 of fields
			set focused to true
		end if
	end if
	if not focused then
		tell application "System Events"
			tell procRef
				set frontmost to true
				delay 0.2
				key code 48
			end tell
		end tell
	end if
	delay 0.3
	tell application "System Events"
		if useKeystroke then
			keystroke textValue
		else
			keystroke textValue
		end if
	end tell
	return true
end typeViaFocus

on firstInputField(procRef)
	set fields to my deepInputFields(procRef)
	if (count of fields) > 0 then return item 1 of fields
	return missing value
end firstInputField

on waitForInputField(procRef, maxWaitSec)
	repeat maxWaitSec times
		set tf to my firstInputField(procRef)
		if tf is not missing value then return tf
		if my isLoginPageVisible(procRef) then return missing value
		delay 1
	end repeat
	return missing value
end waitForInputField

on waitForPasswordField(procRef, appleId, maxWaitSec)
	repeat maxWaitSec times
		set fields to my deepInputFields(procRef)
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
end waitForPasswordField

on fillEmail(procRef, appleId)
	set emailLabels to {"电子邮件或电话号码", "Email or Phone Number", "Email or phone number"}
	set tf to my firstInputField(procRef)
	if tf is not missing value then
		my typeIntoField(tf, appleId, false)
		return true
	end if
	if my isLoginPageVisible(procRef) then
		my typeViaFocus(procRef, appleId, false, emailLabels)
		return true
	end if
	return false
end fillEmail

on fillPassword(procRef, applePassword)
	set passLabels to {"密码", "Password"}
	set tf to my waitForPasswordField(procRef, "", 15)
	if tf is not missing value then
		my typeIntoField(tf, applePassword, true)
		return true
	end if
	my typeViaFocus(procRef, applePassword, true, passLabels)
	return true
end fillPassword

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
	delay 1

	if not my openAppleAccountPane() then
		error "无法打开 Apple Account 设置页（macOS 15 Sequoia 深链失败）"
	end if
	delay 3

	tell application "System Events"
		tell process "System Settings"
			set frontmost to true
			delay 1

			if not my isLoginPageVisible(it) then
				if my firstInputField(it) is missing value then
					my clickSidebarAppleAccount(it)
					delay 1.2
					my clickButtonNamed(it, {"Sign In", "Sign in", "登录", "登入"})
					delay 2
				end if
			end if

			if not my fillEmail(it, appleId) then
				error "未找到 Apple ID 邮箱输入框（请确认系统设置已打开 Apple Account 登录界面）"
			end if

			delay 0.8
			if not my clickButtonNamed(it, {"Continue", "继续", "Next", "下一步"}) then
				key code 36
			end if
			delay 2.5

			set passField to my waitForPasswordField(it, appleId, 15)
			if passField is not missing value then
				my typeIntoField(passField, applePassword, true)
			else
				my typeViaFocus(it, applePassword, true, {"密码", "Password"})
			end if

			delay 0.8
			if not my clickButtonNamed(it, {"Continue", "继续", "Sign In", "Sign in", "登录", "Next", "下一步"}) then
				if not my clickButtonNamed(it, {"Continue", "继续", "Sign In", "登录"}) then
					key code 36
				end if
			end if
		end tell
	end tell

	return "ok"
end run
