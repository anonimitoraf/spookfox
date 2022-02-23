;;; package --- Summary
;;;
;;; Communicate with a browser which have spookfox browser addon installed.
;;
;;; Commentary:
;;;
;;; Spookfox provides means to communicate with your browser. It is (or should
;;; be, after you write some code) capable of doing everything which the browser
;;; allows its extensions to do.
;;;
;;; Please read the readme.org file in this repository for details.
;;;
;;; Code:
(require 'cl-lib)
(require 'json)
(require 'org-capture)

(defvar sf--connection nil
  "Connection to spookfox socket.")

(defvar sf--last-action-output nil
  "Output produced by last spookfox action.")

(defvar spookfox-archived-tabs-target nil
  "Target parse-able by org-capture-template where archived tabs will be saved.")

(defun sf--process-output-filter (process output)
  "Save OUTPUT of last action sent to spookfox PROCESS.

For now let's only keep track of the last message. If it the
communication b/w browser and Emacs gets noisier, we'll introduce
a request-id system to keep track of requests and their
responses, and maintain a data structure."
  (setq sf--last-action-output output))

(defun sf--connect ()
  "Connect or re-connect to spookfox browser addon."
  (setq sf--connection (make-network-process
                        :name "spookfox"
                        :buffer "*spookfox*"
                        :family 'local
                        :remote "/tmp/spookfox.socket"))
  (set-process-filter sf--connection #'sf--process-output-filter))

(defun sf--build-message (msg)
  "Create a message from MSG which can be sent over to spookfox browser addon."
  (concat (json-encode `((sender . "Emacs")
                         (type . "Success")
                         (payload . ,(json-encode msg))))
          "\n"))

(defun sf--send-message (msg)
  "Send a MSG to browsers connected with spookfox.

MSG will be json encoded before sending."
  (when (or
         (not sf--connection)
         (string= (process-status sf--connection) "closed"))
    (sf--connect))
  (process-send-string sf--connection (sf--build-message msg)))

(defun sf--get-last-message (&optional call-count)
  "Synchronously provide latest message received from browser.

Returns a plist obtained be decoding incoming message. Since
socket-communication with spookfox is async, this function blocks
Emacs for 1 second. If it don't receive a response in that time,
it returns `nil`. CALL-COUNT is for internal use, for reaching
exit condition in recursive re-checks."
  (cl-block sf--get-last-message
    (let ((msg-str sf--last-action-output)
          (call-count (or call-count 0)))
      (when (> call-count 5)
        (cl-return-from sf--get-last-message))
      (when (not msg-str)
        (sleep-for 0 200)
        (cl-return-from sf--get-last-message (sf--get-last-message (1+ call-count))))
      (setq sf--last-action-output nil)
      (json-parse-string
       (plist-get (json-parse-string msg-str :object-type 'plist) :payload)
       :object-type 'plist))))

(defun sf--send-action (action)
  "Utility to send ACTION type messages."
  (sf--send-message `((type . ,action))))

(defun sf--get-active-tab ()
  "Get details of active tab in browser."
  (sf--send-action "GET_ACTIVE_TAB")
  (sf--get-last-message))

(defun sf--get-all-tabs ()
  "Get all tabs currently present in browser."
  (sf--send-action "GET_ALL_TABS")
  (sf--get-last-message))

(defun sf--tabs-to-org-nodes (tabs)
  "Convert spookfox browser TABS to level 1 org-subtrees."
  (mapconcat
   (lambda (tab)
     (concat "* " (plist-get tab :title) "\n:PROPERTIES:\n:URL:\t" (plist-get tab :url) "\n:END:\n"))
   tabs))

(defun sf--save-tabs ()
  "Save spookfox tabs as an `org-mode` subtree.

Tabs subtree is saved in `spokfox-archived-tabs-target`"
  (let* ((tabs (sf--get-all-tabs))
         (tabs-subtree (sf--tabs-to-org-nodes tabs)))
    (org-capture-set-target-location spookfox-archived-tabs-target)
    (org-capture-put :template tabs-subtree)
    (org-capture-place-template)))

(provide 'spookfox)
;;; spookfox.el ends here
