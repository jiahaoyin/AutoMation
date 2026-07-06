#!/usr/bin/env osascript
-- Apple ID 2FA：扫描系统弹窗 → 点「允许」→ 读取 6 位验证码（支持 011 172 格式）

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

on isSixDigits(txt)
	if (length of txt) is not 6 then return false
	repeat with i from 1 to 6
		if character i of txt is not in "0123456789" then return false
	end repeat
	return true
end isSixDigits

-- 从任意文本提取 6 位数字（011 172 → 011172）
on digitsFromText(txt)
	if txt is missing value then return ""
	set s to txt as text
	set AppleScript's text item delimiters to {" ", "-", tab, return, character id 160}
	set parts to text items of s
	set AppleScript's text item delimiters to ""
	set joined to parts as text
	if my isSixDigits(joined) then return joined
	set onlyDigits to ""
	repeat with i from 1 to count of characters of s
		set ch to character i of s
		if ch is in "0123456789" then set onlyDigits to onlyDigits & ch
	end repeat
	if my isSixDigits(onlyDigits) then return onlyDigits
	return ""
end digitsFromText

on elementText(el)
	try
		set v to value of el
		if v is not missing value and (v as text) is not "" then return v as text
	end try
	try
		set d to description of el
		if d is not missing value and (d as text) is not "" then return d as text
	end try
	try
		set t to title of el
		if t is not missing value and (t as text) is not "" then return t as text
	end try
	return ""
end elementText

on tryCodeFromText(txt)
	set c to my digitsFromText(txt)
	if c is not "" then return c
	return ""
end tryCodeFromText

on extractSixDigitCodeFromWindow(win)
	tell application "System Events"
		set blob to ""
		try
			repeat with t in (static texts of win)
				set tx to my elementText(t)
				set c to my tryCodeFromText(tx)
				if c is not "" then return c
				set blob to blob & " " & tx
			end repeat
		end try
		try
			repeat with tf in (text fields of win)
				set tx to my elementText(tf)
				set c to my tryCodeFromText(tx)
				if c is not "" then return c
				set blob to blob & " " & tx
			end repeat
		end try
		try
			repeat with g in (groups of win)
				repeat with t in (static texts of g)
					set tx to my elementText(t)
					set c to my tryCodeFromText(tx)
					if c is not "" then return c
					set blob to blob & " " & tx
				end repeat
				repeat with t in (text fields of g)
					set tx to my elementText(t)
					set c to my tryCodeFromText(tx)
					if c is not "" then return c
					set blob to blob & " " & tx
				end repeat
			end repeat
		end try
		try
			repeat with el in (UI elements of win)
				set tx to my elementText(el)
				if tx is not "" then
					set c to my tryCodeFromText(tx)
					if c is not "" then return c
					set blob to blob & " " & tx
				end if
			end repeat
		end try
		set c to my tryCodeFromText(blob)
		if c is not "" then return c
	end tell
	return ""
end extractSixDigitCodeFromWindow

on clickAllowOnWindow(win)
	tell application "System Events"
		repeat with b in (buttons of win)
			try
				set bname to name of b
				if bname is in {"允许", "Allow"} then
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

on windowLooksLikeAppleDialog(win)
	tell application "System Events"
		try
			set blob to ""
			repeat with t in (static texts of win)
				set blob to blob & " " & (my elementText(t))
			end repeat
			if blob contains "Apple" or blob contains "账户" then return true
			if blob contains "Apple ID" then return true
			if blob contains "登录" or blob contains "sign in" then return true
			if blob contains "Sign in" or blob contains "新设备" then return true
			if blob contains "new device" then return true
			if blob contains "验证码" or blob contains "verification code" then return true
			if blob contains "Verification Code" then return true
			if blob contains "双重认证" or blob contains "two-factor" then return true
			if blob contains "Two-Factor" then return true
		end try
	end tell
	return false
end windowLooksLikeAppleDialog

on windowHasAllowButton(win)
	tell application "System Events"
		repeat with b in (buttons of win)
			try
				set bname to name of b
				if bname is in {"允许", "Allow"} then return true
			end try
		end repeat
	end tell
	return false
end windowHasAllowButton

on windowHasDoneOnly(win)
	tell application "System Events"
		try
			set btnCount to count of buttons of win
			if btnCount is 1 then
				set bname to name of button 1 of win
				if bname is in {"完成", "Done", "OK"} then return true
			end if
		end try
	end tell
	return false
end windowHasDoneOnly

on handleProcessWindows(procRef, procName)
	tell procRef
		if not (exists window 1) then return {clicked:false, code:"", dialogProc:procName}
		repeat with w in windows
			set c to my extractSixDigitCodeFromWindow(w)
			if c is not "" then return {clicked:false, code:c, dialogProc:procName}

			if my windowHasAllowButton(w) then
				if my clickAllowOnWindow(w) then return {clicked:true, code:"", dialogProc:procName}
			else if my windowLooksLikeAppleDialog(w) or my windowHasDoneOnly(w) then
				set c2 to my extractSixDigitCodeFromWindow(w)
				if c2 is not "" then return {clicked:false, code:c2, dialogProc:procName}
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
			delay 2
		else
			delay 0.4
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
