#!/usr/bin/env osascript
-- 分阶段 2FA 弹窗：dismiss_stale | pre_allow | read_code
-- 输出 JSON 一行到 stdout

on parseArgs(argv)
	set phase to "read_code"
	set timeoutSec to 6
	repeat with a in argv
		if a starts with "--phase=" then
			set phase to text ((offset of "=" in a) + 1) thru -1 of a
		else if a starts with "--timeout=" then
			set timeoutSec to (text ((offset of "=" in a) + 1) thru -1 of a) as integer
		end if
	end repeat
	return {phase, timeoutSec}
end parseArgs

on procNames()
	return {"FollowUpUI", "CoreAuthUI", "AuthenticationServicesAgent", "SecurityAgent", "UserNotificationCenter", "akd"}
end procNames

on isSixDigits(txt)
	if (length of txt) is not 6 then return false
	repeat with i from 1 to 6
		if character i of txt is not in "0123456789" then return false
	end repeat
	return true
end isSixDigits

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

on elText(el)
	try
		set v to value of el
		if v is not missing value and (v as text) is not "" then return v as text
	end try
	try
		set t to title of el
		if t is not missing value and (t as text) is not "" then return t as text
	end try
	try
		set d to description of el
		if d is not missing value and (d as text) is not "" then return d as text
	end try
	return ""
end elText

on windowBlob(win)
	set blob to ""
	tell application "System Events"
		try
			repeat with t in (static texts of win)
				set blob to blob & " " & (my elText(t))
			end repeat
		end try
		try
			repeat with g in (groups of win)
				repeat with t in (static texts of g)
					set blob to blob & " " & (my elText(t))
				end repeat
			end repeat
		end try
	end tell
	return blob
end windowBlob

on hasCodeDisplayPrompt(blob)
	if blob contains "在网页上输入此验证码" then return true
	if blob contains "在网页上输入" and blob contains "验证码" then return true
	if blob contains "输入此验证码" then return true
	if blob contains "verification code on the web" then return true
	if blob contains "Enter this verification code" then return true
	return false
end hasCodeDisplayPrompt

on extractCodeFromWindow(win)
	tell application "System Events"
		try
			repeat with t in (static texts of win)
				set tx to my elText(t)
				set c to my digitsFromText(tx)
				if c is not "" and (length of (tx as text)) < 20 then return {c, tx}
			end repeat
		end try
		try
			repeat with g in (groups of win)
				repeat with t in (static texts of g)
					set tx to my elText(t)
					set c to my digitsFromText(tx)
					if c is not "" and (length of (tx as text)) < 20 then return {c, tx}
				end repeat
			end repeat
		end try
	end tell
	return {"", ""}
end extractCodeFromWindow

on hasButton(win, names)
	tell application "System Events"
		repeat with b in (buttons of win)
			try
				set bn to name of b
				repeat with n in names
					if bn is n or bn contains n then return true
				end repeat
			end try
		end repeat
	end tell
	return false
end hasButton

on clickButton(win, names)
	tell application "System Events"
		repeat with b in (buttons of win)
			try
				set bn to name of b
				repeat with n in names
					if bn is n or bn contains n then
						click b
						return true
					end if
				end repeat
			end try
		end repeat
		try
			set n to count of buttons of win
			if n is greater than or equal to 2 then
				click button n of win
				return true
			end if
		end try
	end tell
	return false
end clickButton

on eachDialogWindow()
	set results to {}
	tell application "System Events"
		repeat with pn in my procNames()
			if exists process pn then
				tell process pn
					repeat with w in windows
						set end of results to {pn, w}
					end repeat
				end tell
			end if
		end repeat
		repeat with procRef in (every process whose visible is true)
			set pn to name of procRef
			try
				tell procRef
					repeat with w in windows
						set end of results to {pn, w}
					end repeat
				end tell
			end try
		end repeat
	end tell
	return results
end eachDialogWindow

on jsonEscape(s)
	set s to s as text
	set AppleScript's text item delimiters to "\""
	set parts to text items of s
	set AppleScript's text item delimiters to "\\\""
	set s to parts as text
	set AppleScript's text item delimiters to ""
	return s
end jsonEscape

on emitJson(ok, code, action, source, raw)
	set c to code
	if c is missing value then set c to ""
	set a to action
	if a is missing value then set a to "none"
	set src to source
	if src is missing value then set src to ""
	set r to raw
	if r is missing value then set r to ""
	set okStr to "false"
	if ok then set okStr to "true"
	return "{\"ok\":" & okStr & ",\"code\":\"" & c & "\",\"action\":\"" & a & "\",\"source\":\"" & (my jsonEscape(src)) & "\",\"raw\":\"" & (my jsonEscape(r)) & "\"}"
end emitJson

on scanPhase(phase)
	set dialogs to my eachDialogWindow()
	repeat with itemRef in dialogs
		set pn to item 1 of itemRef
		set w to item 2 of itemRef
		set blob to my windowBlob(w)
		set codePair to my extractCodeFromWindow(w)
		set code to item 1 of codePair
		set raw to item 2 of codePair
		set hasPrompt to my hasCodeDisplayPrompt(blob)
		set hasAllow to my hasButton(w, {"允许", "Allow"})
		set hasDone to my hasButton(w, {"完成", "Done", "OK"})

		if phase is "dismiss_stale" then
			if hasPrompt or code is not "" then
				if my clickButton(w, {"完成", "Done", "OK"}) then
					return my emitJson(true, code, "dismissed_stale", pn, raw)
				end if
			end if
		else if phase is "pre_allow" then
			if hasPrompt or code is not "" then
				if my clickButton(w, {"完成", "Done", "OK"}) then
					return my emitJson(true, code, "dismissed_stale", pn, raw)
				end if
			end if
			if hasAllow and not hasPrompt then
				if my clickButton(w, {"允许", "Allow"}) then
					return my emitJson(true, "", "clicked_allow", pn, "")
				end if
			end if
			if hasAllow and code is "" then
				if my clickButton(w, {"允许", "Allow"}) then
					return my emitJson(true, "", "clicked_allow", pn, "")
				end if
			end if
		else if phase is "read_code" then
			if hasPrompt and code is not "" then
				return my emitJson(true, code, "read_code", pn, raw)
			end if
		end if
	end repeat
	return my emitJson(false, "", "none", "", "")
end scanPhase

on run argv
	set parsed to my parseArgs(argv)
	set phase to item 1 of parsed
	set timeoutSec to item 2 of parsed
	set deadline to (current date) + timeoutSec
	repeat while (current date) < deadline
		set out to my scanPhase(phase)
		if out contains "\"ok\":true" then
			do shell script "printf %s\\n " & quoted form of out
			return out
		end if
		if phase is "pre_allow" and out contains "clicked_allow" then
			do shell script "printf %s\\n " & quoted form of out
			return out
		end if
		delay 0.35
	end repeat
	set out to my emitJson(false, "", "none", "", "")
	do shell script "printf %s\\n " & quoted form of out
	error "timeout" number -128
end run
