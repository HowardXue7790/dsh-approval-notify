' Forward a dsh-approval-notify: URI to the plugin loopback server. No window is shown.
Dim u, p, scheme, http
If WScript.Arguments.Count < 1 Then WScript.Quit 0
u = WScript.Arguments(0)
scheme = "dsh-approval-notify:"
p = u
If LCase(Left(p, Len(scheme))) = scheme Then p = Mid(p, Len(scheme) + 1)
Do While Len(p) > 0
  If Right(p, 1) <> "/" Then Exit Do
  p = Left(p, Len(p) - 1)
Loop
If LCase(Left(p, 2)) <> "//" Then WScript.Quit 0
If InStr(1, LCase(p), "//127.0.0.1:", 1) <> 1 Then WScript.Quit 0
Set http = CreateObject("MSXML2.XMLHTTP")
On Error Resume Next
http.open "GET", "http:" & p, False
http.send