#!/usr/bin/env osascript
-- Apple ID 2FA：扫描系统弹窗 → 点「允许」→ 读取 6 位验证码

on parseTimeout(argv)
	set timeoutSeconds to 120
	repeat with a in argv
		if a starts with "--timeout=" then
			set timeoutSeconds to (text ((offset of "=" in a) + 1) thru -1 of a) as integer
		end if
	end repeat
	return timeoutSeconds
end parseTimeout

on isWatchMode(argv)
	repeat with a in argv
		if a is "--watch" then return true
	end repeat
	return false
end isWatchMode

on priorityProcessNames()
	return {"FollowUpUI", "CoreAuthUI", "AuthenticationServicesAgent", "UserNotificationCenter", "akd", "SecurityAgent", "loginwindow", "System Settings", "系统设置"}
end priorityProcessNames

on normalizeSixDigit(txt)
	if txt is missing value then return ""
	set AppleScript's text item delimiters to {" ", "-", tab, return, character id 160}
	set parts to text items of (txt as text)
	set AppleScript's text item delimiters to ""
	set digits to parts as text
	if (length of digits) is 6 and digits is in "0123456789" then return digits
	return ""
end normalizeSixDigit

on elementText(el)
	try
		set v to value of el
		if v is not missing value and (v as text) is not "" then return v as text
	end try
	try
		set d to description of el
		if d is not missing value and (d as text) is not "" then return d as text
	end try
	return ""
end elementText

on extractSixDigitCodeFromWindow(win)
	tell application "System Events"
		try
			repeat with t in (static texts of win)
				set c to my normalizeSixDigit(my elementText(t))
				if c is not "" then return c
			end repeat
		end try
		try
			repeat with g in (groups of win)
				repeat with t in (static texts of g)
					set c to my normalizeSixDigit(my elementText(t))
					if c is not "" then return c
				end repeat
			end repeat
		end try
	end tell
	return ""
end extractSixDigitCodeFromWindow

on clickAllowOnWindow(win)
	tell application "System Events"
		repeat with b in (buttons of win)
			try
				set bname to name of b
				if bname is in {"允许", "Allow", "OK", "好"} then
					click b
					return true
				end if
			end try
		end repeat
		try
			set btnCount to count of buttons of win
			if btnCount is greater than or equal to 2 then
				click button btnCount of win
				return true
			end if
		end try
	end tell
	return false
end clickAllowOnWindow

on windowLooksLikeAppleSignIn(win)
	tell application "System Events"
		try
			set blob to ""
			repeat with t in (static texts of win)
				set blob to blob & " " & (my elementText(t))
			end repeat
			if blob contains "Apple" or blob contains "账户" then return true
			if blob contains "登录" or blob contains "sign in" then return true
			if blob contains "Sign in" or blob contains "新设备" then return true
			if blob contains "new device" or blob contains "双重认证" then return true
			if blob contains "two-factor" or blob contains "Two-Factor" then return true
		end try
	end tell
	return false
end windowLooksLikeAppleSignIn

on windowHasAllowButton(win)
	tell application "System Events"
		repeat with b in (buttons of win)
			try
				set bname to name of b
				if bname is in {"允许", "Allow", "OK", "好"} then return true
			end try
		end repeat
		if (count of buttons of win) is greater than or equal to 2 then return true
	end tell
	return false
end windowHasAllowButton

on handleProcessWindows(procRef, procName)
	tell procRef
		if not (exists window 1) then return {clicked:false, code:"", dialogProc:procName}
		repeat with w in windows
			set hasAllow to my windowHasAllowButton(w)

			set c to my extractSixDigitCodeFromWindow(w)
			if c is not "" then return {clicked:false, code:c, dialogProc:procName}

			if hasAllow then
				if my clickAllowOnWindow(w) then return {clicked:true, code:"", dialogProc:procName}
			else
				if my windowLooksLikeAppleSignIn(w) then
					set c2 to my extractSixDigitCodeFromWindow(w)
					if c2 is not "" then return {clicked:false, code:c2, dialogProc:procName}
				end if
			end if
		end repeat
	end tell
	return {clicked:false, code:"", dialogProc:procName}
end handleProcessWindows

on scanOnce()
	tell application "System Events"
		repeat with procName in my priorityProcessNames()
			if exists process procName then
				set r to my handleProcessWindows(process procName, procName)
				if (code of r) is not "" then return r
				if (clicked of r) then return r
			end if
		end repeat

		repeat with procRef in (every process whose visible is true)
			set procName to name of procRef
			try
				set r to my handleProcessWindows(procRef, procName)
				if (code of r) is not "" then return r
				if (clicked of r) then return r
			end try
		end repeat
	end tell
	return {clicked:false, code:"", dialogProc:""}
end scanOnce

on closeDialog(procName)
	try
		tell application "System Events"
			if exists process procName then
				tell process procName
					try
						click button "Done" of window 1
					on error
						try
							click button "完成" of window 1
						end try
					end try
				end tell
			end if
		end tell
	end try
end closeDialog

on tryOnce(timeoutSeconds)
	set deadline to (current date) + timeoutSeconds
	repeat while (current date) < deadline
		set r to my scanOnce()
		set c to code of r
		if c is not "" then
			my closeDialog(dialogProc of r)
			return c
		end if
		if (clicked of r) then
			delay 2.5
		else
			delay 0.45
		end if
	end repeat
	return ""
end tryOnce

on run argv
	set timeoutSeconds to my parseTimeout(argv)
	set watchMode to my isWatchMode(argv)

	if watchMode then
		repeat
			set code to my tryOnce(5)
			if code is not "" then
				do shell script "printf %s " & quoted form of code
			end if
			delay 1
		end repeat
	else
		set code to my tryOnce(timeoutSeconds)
		if code is "" then
			error "2FA dialog not found or code not readable within timeout"
		end if
		return code
	end if
end run
