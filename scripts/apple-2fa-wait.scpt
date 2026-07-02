#!/usr/bin/env osascript
-- Wait for Apple ID 2FA FollowUpUI dialog, click Allow, return 6-digit code on stdout.
-- Usage:
--   ./scripts/apple-2fa-wait.scpt           # single attempt, 120s timeout
--   ./scripts/apple-2fa-wait.scpt --watch   # loop forever (for long-running automation)

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

on clickAllowButton(procRef)
	try
		click button "Allow" of window 1 of procRef
		return true
	on error
		try
			click button "允许" of window 1 of procRef
			return true
		on error
			try
				click button 1 of window 1 of procRef
				return true
			on error
				return false
			end try
		end try
	end try
end clickAllowButton

on closeDialog(procRef)
	try
		click button "Done" of window 1 of procRef
	on error
		try
			click button "完成" of window 1 of procRef
		end try
	end try
end closeDialog

on extractSixDigitCode(procRef)
	set codeText to ""
	try
		set codeText to value of static text 1 of group 1 of window 1 of procRef
	on error
		repeat with t in (static texts of window 1 of procRef)
			set v to value of t
			if v matches "[0-9]{6}" then
				set codeText to v
				exit repeat
			end if
		end repeat
	end try

	if codeText is "" then return ""

	set AppleScript's text item delimiters to {" ", "-", tab, return}
	set parts to text items of codeText
	set AppleScript's text item delimiters to ""
	set codeText to parts as text

	if (length of codeText) is 6 and codeText is in "0123456789" then
		return codeText
	end if
	return ""
end extractSixDigitCode

on tryOnce(timeoutSeconds)
	set deadline to (current date) + timeoutSeconds
	repeat while (current date) < deadline
		tell application "System Events"
			if exists process "FollowUpUI" then
				tell process "FollowUpUI"
					if exists window 1 then
						my clickAllowButton(it)
						delay 2
						set code to my extractSixDigitCode(it)
						if code is not "" then
							my closeDialog(it)
							return code
						end if
					end if
				end tell
			end if
		end tell
		delay 0.5
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
