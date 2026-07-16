#!/usr/bin/perl

# new-cloud-project.pl - Create a new Grafana Cloud k6 project and fill it with
# the right stress-test templates for the partner - one command, no web-UI
# clicking, no manual paste.
#
# The partner's platform decides which patron-facing tests get created:
#   Aspen + Koha ( default ) - patrons search Aspen Discovery; the Koha OPAC is
#                              hit only by the Aspen API. Creates the Aspen tests
#                              + Daily Operations ( PATRON_MODE=aspen ) + training.
#   Koha-only ( --koha-only ) - patrons search the Koha OPAC directly. Creates
#                              the OPAC tests + Daily Operations ( PATRON_MODE=opac )
#                              + training.
#
# Usage:
#   ./bin/new-cloud-project.pl "Partner X"              ( prompts, defaults to Aspen + Koha )
#   ./bin/new-cloud-project.pl "Partner X" --koha-only  ( Koha-only, no Aspen tests )
#   ./bin/new-cloud-project.pl "Partner X" --aspen      ( force Aspen + Koha, no prompt )
#   ./bin/new-cloud-project.pl "Foo" --org 3432454 --dry-run
#   ./bin/new-cloud-project.pl "Foo" --defaults            # accept every default, no prompts
#   ./bin/new-cloud-project.pl "Foo" --set STAFF_URL=https://x --defaults
#
# Interactively prompts for each project variable ( target URLs, load rates,
# class size... ) with an explanation and a default, then bakes the answers into
# that project's tests so they come pre-configured for the server. Only the
# variables relevant to the chosen platform are asked. Press Enter to accept a
# default. --defaults skips the prompts; --set VAR=VALUE pre-seeds a variable's
# default ( repeatable ). Credentials are NOT prompted - they stay on the
# universal Grafana secrets.
#
# Needs 'k6 cloud login --token <token>' once first ( token from the Grafana
# Cloud k6 app ). See docs/GRAFANA_CLOUD.md.
#
# ( VU limits can't be set through the API - that's an admin/plan action in the
# UI - so raise them there if a big run needs more than the project default. )

use Modern::Perl;
use Getopt::Long;
use FindBin;
use HTTP::Tiny;
use JSON::PP;

# The per-project variables prompted for and baked into the new project's tests.
# 'mode' = which platform the variable applies to: 'both', 'aspen', or 'opac'.
# ( Credentials are deliberately excluded - they come from universal secrets. )
my @CONFIG_VARS = (
    { name => 'STAFF_URL',                   mode => 'both',  desc => 'Staff interface base URL (login + Daily Operations + API)',           default => 'https://staff.example.org' },
    { name => 'STAFF_USER',                  mode => 'both',  desc => 'Superlibrarian username for the login-based tests',                   default => 'bwssupport' },
    { name => 'OPAC_URL',                    mode => 'opac',  desc => 'Public catalog (OPAC) base URL - patrons search it directly',         default => 'https://catalog.example.org' },
    { name => 'ASPEN_BASE_URL',              mode => 'aspen', desc => 'Aspen Discovery base URL - the patron catalog',                       default => 'https://discovery.example.org' },
    { name => 'OPAC_SEARCHES_PER_HOUR',      mode => 'opac',  desc => 'Peak OPAC catalog searches per hour to sustain',                      default => '5000', num => 1 },
    { name => 'PATRON_SESSIONS_PER_HOUR',    mode => 'aspen', desc => 'Patron sessions/hour (Aspen->Koha API load, Daily Operations)',       default => '2000', num => 1 },
    { name => 'STAFF_TRANSACTIONS_PER_HOUR', mode => 'both',  desc => 'Staff transactions per hour (Daily Operations test)',                 default => '1000', num => 1 },
    { name => 'TRAINING_ATTENDEES',          mode => 'both',  desc => 'Training class size (number of attendees)',                           default => '50', num => 1 },
    { name => 'CATALOG_SEARCH_TERM',         mode => 'both',  desc => 'A search term with hits in the target catalog',                       default => 'harry potter' },
);

# The tests created for each platform ( filenames become sync-cloud-tests.pl
# filters ). Daily Operations + training are common; the patron-facing tests
# differ. PATRON_MODE is baked from the platform, not prompted.
my %TEST_SETS = (
    aspen => [qw( aspen_http.js aspen_browser.js koha_steady_state.js koha_training_protocol.js koha_training_browser.js )],
    opac  => [qw( koha_opac_http.js koha_opac_browser.js koha_steady_state.js koha_training_protocol.js koha_training_browser.js )],
);

my ( $org_override, $dry_run, $help, $opt_defaults, $opt_koha_only, $opt_aspen );
my %seed;
GetOptions(
    'org=s'     => \$org_override,
    'set=s%'    => \%seed,
    'koha-only' => \$opt_koha_only,
    'aspen'     => \$opt_aspen,
    'defaults'  => \$opt_defaults,
    'dry-run'   => \$dry_run,
    'help'      => \$help,
) or die "Try --help\n";

_usage() if $help;
die "Pass only one of --aspen / --koha-only\n" if $opt_aspen && $opt_koha_only;

my $name = shift @ARGV;
die "Usage: $0 \"<project name>\" [--koha-only] [--org ID] [--dry-run]\n"
    unless defined $name && length $name;
die "Unexpected extra arguments: @ARGV\n" if @ARGV;

# All stress-testing projects share this prefix so they group in the project
# list; don't double-prefix if the user already typed it.
my $NAME_PREFIX = "Stress Testing - ";
$name = $NAME_PREFIX . $name unless $name =~ /^\Q$NAME_PREFIX\E/;

my $token = _k6_token();
my $http  = HTTP::Tiny->new;

# Discover the org ( unless given )
my $org = $org_override;
unless ( defined $org && length $org ) {
    my $res = _api( 'GET', "https://api.k6.io/v3/organizations" );
    die "Error: could not discover organization (HTTP $res->{status})\n" unless $res->{success};
    my $orgs = decode_json( $res->{content} )->{organizations} || [];
    die "Error: no organizations found for this token.\n" unless @$orgs;
    if ( @$orgs > 1 ) {
        say STDERR "Multiple orgs found - pass --org <id>:";
        say STDERR "  $_->{id}  $_->{name}" for @$orgs;
        exit 1;
    }
    $org = $orgs->[0]{id};
}

# Platform decides the patron-facing test set + PATRON_MODE. --aspen / --koha-only
# force it; otherwise ask ( interactive ) or default to Aspen ( most libraries
# front Koha with Aspen ). $platform is 'aspen' or 'opac' ( = PATRON_MODE value ).
my $platform;
if    ($opt_koha_only) { $platform = 'opac'; }
elsif ($opt_aspen)     { $platform = 'aspen'; }
elsif ( -t STDIN && !$opt_defaults && !$dry_run ) {
    say "";
    say "Platform for this partner:";
    say "  Aspen + Koha - patrons search Aspen Discovery; the Koha OPAC is hit only by the Aspen API";
    say "  Koha-only    - patrons search the Koha OPAC directly";
    my $ans = _read_line( "  Use Aspen Discovery in front of Koha? [Y/n]: ", "Y" );
    $platform = ( $ans =~ /^\s*n/i ) ? 'opac' : 'aspen';
} else {
    $platform = 'aspen';
}
my $platform_label = $platform eq 'aspen' ? 'Aspen + Koha' : 'Koha-only';

# Gather this project's settings ( only the vars for this platform )
my %settings = _prompt_settings($platform);

if ($dry_run) {
    say "\nDRY: would create project '$name' in org $org";
    say "  platform: $platform_label (PATRON_MODE=$platform)";
    say "  tests:    " . join( ", ", @{ $TEST_SETS{$platform} } );
    say "  settings:";
    say "    $_->{name}=$settings{ $_->{name} }" for _vars_for($platform);
    exit 0;
}

# Create the project ( POST returns 201 )
my $res = _api( 'POST', "https://api.k6.io/v3/projects",
    { name => $name, organization_id => int($org) } );
die "Error: create project failed HTTP $res->{status}: " . _short( $res->{content} ) . "\n"
    unless $res->{success};
my $pid = decode_json( $res->{content} )->{project}{id}
    or die "Error: project created but no id returned.\n";
say "Created project '$name' (id $pid) in org $org  [$platform_label]";

# Populate the platform's tests, baking in this project's settings. PATRON_MODE
# is baked from the platform. Only vars the user gave a value for are baked; a
# blank leaves that test's template default untouched.
say "\nPopulating the $platform_label tests into project $pid ...";
my $sync     = "$FindBin::Bin/sync-cloud-tests.pl";
my @set_args = ( '--set', "PATRON_MODE=$platform" );
push @set_args, map { ( '--set', "$_->{name}=$settings{ $_->{name} }" ) }
    grep { length $settings{ $_->{name} } } _vars_for($platform);
system( $^X, $sync, '--project', $pid, @set_args, @{ $TEST_SETS{$platform} } ) == 0
    or die "Populating templates failed.\n";

say "";
say "=" x 42;
say "Project ready:";
say "  https://bws.grafana.net/a/k6-app/projects/$pid";
say "";
say "The tests are pre-configured for this server. Run each as-is, or";
say "tweak the <<< SET values first.";
say "See docs/GRAFANA_CLOUD.md.";
say "";
say "Secrets ( staff-pass, the ingress token ) are org-wide, so they apply";
say "here automatically. Target servers need RESTBasicAuth enabled.";
say "";
say "Note: the project uses default VU limits - big runs ( e.g. the OPAC peak )";
say "may need them raised in the UI ( project settings / Grafana support ).";
say "=" x 42;

# ------------------------------------------------------------

# The config vars that apply to a platform ( its own + the shared ones ).
sub _vars_for {
    my ($platform) = @_;
    return grep { $_->{mode} eq 'both' || $_->{mode} eq $platform } @CONFIG_VARS;
}

sub _api {
    my ( $method, $url, $body ) = @_;
    my %opts = ( headers => { Authorization => "Bearer $token" } );
    if ( defined $body ) {
        $opts{headers}{'Content-Type'} = 'application/json';
        $opts{content} = encode_json($body);
    }
    return $http->request( $method, $url, \%opts );
}

# Read one line with basic editing ( left/right arrows, Home/End, backspace,
# Ctrl-A/E/U ) by driving the terminal in raw mode ourselves - a plain <STDIN>
# read is canonical-mode, which passes arrow keys through as "^[[D" etc.
# Falls back to a plain read when stdin/stdout isn't a terminal.
sub _read_line {
    my ( $prompt, $default ) = @_;

    unless ( -t STDIN && -t STDOUT ) {
        print $prompt;
        my $in = <STDIN>;
        return $default unless defined $in;
        chomp $in;
        return length $in ? $in : $default;
    }

    local $| = 1;    # autoflush - we echo by redrawing, so each keystroke must flush now
    my $saved = `stty -g 2>/dev/null`;
    chomp $saved;
    system( "stty", "-icanon", "-echo", "min", "1", "time", "0" );
    my $restore = sub { system( "stty", $saved ) if length $saved };
    local $SIG{INT} = sub { $restore->(); print "\n"; exit 130 };

    my @buf;
    my $pos = 0;
    my $draw = sub {
        print "\r\e[K", $prompt, join( '', @buf );
        my $back = @buf - $pos;
        print "\e[${back}D" if $back > 0;
    };

    my $err;
    eval {
        $draw->();
        my $c;
        while ( sysread( STDIN, $c, 1 ) ) {
            if    ( $c eq "\n" || $c eq "\r" ) { last }
            elsif ( $c eq "\x7f" || $c eq "\x08" ) { splice( @buf, --$pos, 1 ) if $pos > 0 }    # backspace
            elsif ( $c eq "\x03" ) { $restore->(); print "\n"; exit 130 }                       # Ctrl-C
            elsif ( $c eq "\x15" ) { @buf = (); $pos = 0 }                                       # Ctrl-U
            elsif ( $c eq "\x01" ) { $pos = 0 }                                                  # Ctrl-A
            elsif ( $c eq "\x05" ) { $pos = @buf }                                               # Ctrl-E
            elsif ( $c eq "\e" ) {                                                               # escape seq
                sysread( STDIN, my $b, 1 ) or next;
                next unless $b eq '[';
                sysread( STDIN, my $k, 1 ) or next;
                if    ( $k eq 'D' ) { $pos-- if $pos > 0 }                                       # left
                elsif ( $k eq 'C' ) { $pos++ if $pos < @buf }                                    # right
                elsif ( $k eq 'H' ) { $pos = 0 }                                                 # home
                elsif ( $k eq 'F' ) { $pos = @buf }                                              # end
                elsif ( $k eq '3' ) { sysread( STDIN, my $t, 1 ); splice( @buf, $pos, 1 ) if $pos < @buf }  # Del
            }
            elsif ( $c ge ' ' ) { splice( @buf, $pos, 0, $c ); $pos++ }                          # printable
            $draw->();
        }
        1;
    } or $err = $@;

    $restore->();
    print "\n";
    die $err if $err;

    my $val = join( '', @buf );
    return length $val ? $val : $default;
}

# Ask for each config var that applies to the platform ( explanation + default ).
# Returns name => value. Non-interactive ( --defaults, dry-run, or no TTY ) just
# takes the defaults, with any --set VAR=VALUE seeds applied.
sub _prompt_settings {
    my ($platform) = @_;
    my %s;
    my $interactive = ( -t STDIN ) && !$opt_defaults && !$dry_run;
    say "\nConfigure this project's tests ( press Enter to accept the default ):" if $interactive;
    for my $v ( _vars_for($platform) ) {
        my $name    = $v->{name};
        my $default = defined $seed{$name} ? $seed{$name} : $v->{default};
        my $val     = $default;
        if ($interactive) {
            while (1) {
                say "";
                say "  $name - $v->{desc}";
                $val = _read_line( "    [$default]: ", $default );
                $val =~ s/^\s+|\s+$//g;
                if ( $v->{num} && $val !~ /^-?\d+(?:\.\d+)?$/ ) {
                    say "    ! must be a number";
                    next;
                }
                last;
            }
        }
        $s{$name} = $val;
    }
    return %s;
}

sub _k6_token {
    my $cfg = "$ENV{HOME}/Library/Application Support/k6/config.json";
    die "Error: k6 config not found at $cfg - run 'k6 cloud login --token <token>' first.\n"
        unless -f $cfg;
    open my $fh, '<', $cfg or die "Cannot read $cfg: $!\n";
    local $/;
    my $data = decode_json(<$fh>);
    my $tok = $data->{collectors}{cloud}{token}
        or die "Error: no cloud token in $cfg - run 'k6 cloud login' first.\n";
    return $tok;
}

sub _short { my ($s) = @_; $s //= ''; $s =~ s/\s+/ /g; return substr( $s, 0, 200 ); }

# Print the leading comment block ( the usage header ) and exit.
sub _usage {
    open my $fh, '<', $0 or exit 1;
    my $seen;
    while ( my $l = <$fh> ) {
        next if $l =~ /^#!/;                 # skip shebang
        next if !$seen && $l =~ /^\s*$/;     # skip blank lines before the header
        last unless $l =~ /^#/;              # stop at the first non-comment line
        $seen = 1;
        $l =~ s/^# ?//;
        print $l;
    }
    exit 0;
}
